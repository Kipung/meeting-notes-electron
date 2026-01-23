#!/usr/bin/env python3
"""
Record microphone audio, detect utterances with Silero VAD, and transcribe in-process.

Outputs:
- <session_dir>/audio.wav
- <session_dir>/transcript.txt

Notes:
- Uses PyAudio for recording, Silero VAD for utterance boundaries, and Whisper for transcription.
- Designed to be controlled by Electron: Start spawns this process, Stop sends SIGTERM.
- Emits a single JSON line on stdout when transcription is complete.
"""

import argparse
import collections
import json
import os
import queue
import signal
import sys
import threading
import time
import wave

import numpy as np
import pyaudio
import torch
import whisper

STOP = False
PAUSED = False
PAUSE_STARTED_AT = None
PAUSE_ADJUST = 0.0
PAUSE_LOCK = threading.Lock()


def _handle_stop(signum, frame):
    global STOP
    STOP = True


def _set_pause_state(state: bool):
    global PAUSED, PAUSE_STARTED_AT, PAUSE_ADJUST
    with PAUSE_LOCK:
        if state == PAUSED:
            return
        if state:
            PAUSED = True
            PAUSE_STARTED_AT = time.time()
        else:
            PAUSED = False
            if PAUSE_STARTED_AT is not None:
                PAUSE_ADJUST += max(0.0, time.time() - PAUSE_STARTED_AT)
            PAUSE_STARTED_AT = None


def _consume_pause_adjustment() -> float:
    global PAUSE_ADJUST
    with PAUSE_LOCK:
        adjust = PAUSE_ADJUST
        PAUSE_ADJUST = 0.0
        return adjust


def _is_paused() -> bool:
    with PAUSE_LOCK:
        return PAUSED


def _stdin_listener():
    for line in sys.stdin:
        cmd = line.strip().lower()
        if cmd == "pause":
            _set_pause_state(True)
        elif cmd == "resume":
            _set_pause_state(False)
        elif cmd == "stop":
            _handle_stop(None, None)


def _vad_load():
    try:
        import torchaudio  # noqa: F401
    except Exception as e:
        print(f"[vad] missing torchaudio: {e}", file=sys.stderr, flush=True)
        return None
    try:
        model, _utils = torch.hub.load(
            repo_or_dir="snakers4/silero-vad",
            model="silero_vad",
            trust_repo=True,
            force_reload=False,
        )
        return model
    except Exception as e:
        print(f"[vad] failed to load silero-vad: {e}", file=sys.stderr, flush=True)
        return None


def _vad_prob(vad_model, audio_float: np.ndarray, sample_rate: int) -> float:
    if vad_model is None:
        return 0.0
    with torch.no_grad():
        tensor = torch.from_numpy(audio_float)
        prob = vad_model(tensor, sample_rate)
        if isinstance(prob, torch.Tensor):
            return float(prob.item())
        return float(prob)


def _write_transcript(path: str, text: str):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, help="Output WAV path (e.g., sessions/.../audio.wav)")
    parser.add_argument("--model", default="small.en", help="Whisper model name")
    parser.add_argument("--rate", type=int, default=16000)
    parser.add_argument("--channels", type=int, default=1)
    parser.add_argument("--chunk", type=int, default=512)
    parser.add_argument("--device-index", type=int, default=None, help="Optional input device index")
    parser.add_argument("--transcript-out", default=None, help="Output transcript path")
    parser.add_argument("--vad-threshold", type=float, default=0.5)
    parser.add_argument("--vad-min-silence-ms", type=int, default=600)
    parser.add_argument("--vad-min-speech-ms", type=int, default=200)
    parser.add_argument("--vad-pre-pad-ms", type=int, default=200)
    parser.add_argument("--vad-post-pad-ms", type=int, default=200)
    args = parser.parse_args()

    if args.channels != 1:
        print("[record] only mono input is supported for VAD, forcing channels=1", file=sys.stderr, flush=True)
        args.channels = 1

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    transcript_path = args.transcript_out or os.path.join(os.path.dirname(args.out), "transcript.txt")

    signal.signal(signal.SIGTERM, _handle_stop)
    signal.signal(signal.SIGINT, _handle_stop)

    vad_model = _vad_load()
    if vad_model is None:
        print("[record] VAD model failed to load, exiting", file=sys.stderr, flush=True)
        sys.exit(5)
    if hasattr(vad_model, "reset_states"):
        vad_model.reset_states()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[transcribe] loading model {args.model} on {device}", flush=True)
    try:
        download_root = os.environ.get("WHISPER_ROOT")
        whisper_model = whisper.load_model(args.model, device=device, download_root=download_root)
    except Exception as e:
        print(f"[transcribe] failed to load model: {e}", file=sys.stderr, flush=True)
        sys.exit(3)

    pa = pyaudio.PyAudio()
    stdin_thread = threading.Thread(target=_stdin_listener, daemon=True)
    stdin_thread.start()

    stream_kwargs = dict(
        format=pyaudio.paInt16,
        channels=args.channels,
        rate=args.rate,
        input=True,
        frames_per_buffer=args.chunk,
    )
    if args.device_index is not None:
        stream_kwargs["input_device_index"] = args.device_index

    try:
        stream = pa.open(**stream_kwargs)
    except Exception as e:
        print(f"[record] Failed to open input stream: {e}", file=sys.stderr, flush=True)
        try:
            pa.terminate()
        except Exception:
            pass
        sys.exit(1)

    sample_width = pa.get_sample_size(pyaudio.paInt16)
    wf = wave.open(args.out, "wb")
    wf.setnchannels(args.channels)
    wf.setsampwidth(sample_width)
    wf.setframerate(args.rate)

    chunk_ms = (args.chunk / float(args.rate)) * 1000.0
    pre_pad_frames = max(0, int(args.vad_pre_pad_ms / chunk_ms)) if chunk_ms > 0 else 0
    post_pad_frames = max(0, int(args.vad_post_pad_ms / chunk_ms)) if chunk_ms > 0 else 0
    min_silence_frames = max(1, int(args.vad_min_silence_ms / chunk_ms)) if chunk_ms > 0 else 1
    min_speech_frames = max(1, int(args.vad_min_speech_ms / chunk_ms)) if chunk_ms > 0 else 1
    min_utterance_samples = int((args.vad_min_speech_ms / 1000.0) * args.rate)

    pre_buffer = collections.deque(maxlen=pre_pad_frames or 1)
    silence_buffer: list[np.ndarray] = []
    utterance_frames: list[np.ndarray] = []
    speech_run = 0
    speaking = False

    transcript_parts: list[str] = []
    transcript_lock = threading.Lock()
    utterance_queue = queue.Queue()

    def transcribe_worker():
        while True:
            item = utterance_queue.get()
            try:
                if item is None:
                    return
                audio_i16 = item
                audio_f32 = audio_i16.astype(np.float32) / 32768.0
                result = whisper_model.transcribe(audio_f32, language="en", task="transcribe")
                text = result.get("text", "").strip()
                if text:
                    with transcript_lock:
                        transcript_parts.append(text)
            except Exception as e:
                print(f"[transcribe] utterance error: {e}", file=sys.stderr, flush=True)
            finally:
                utterance_queue.task_done()

    worker = threading.Thread(target=transcribe_worker, daemon=True)
    worker.start()

    print(f"[record] START out={args.out}", flush=True)

    start_t = time.time()
    last_print = 0.0

    def finalize_utterance(frames: list[np.ndarray]):
        if not frames:
            return
        audio_i16 = np.concatenate(frames)
        if audio_i16.size < min_utterance_samples:
            return
        utterance_queue.put(audio_i16)

    try:
        while not STOP:
            if _is_paused():
                try:
                    if stream.is_active():
                        stream.stop_stream()
                except Exception:
                    pass
                if hasattr(vad_model, "reset_states"):
                    vad_model.reset_states()
                pre_buffer.clear()
                silence_buffer.clear()
                utterance_frames.clear()
                speaking = False
                speech_run = 0
                time.sleep(0.05)
                continue
            else:
                try:
                    if not stream.is_active():
                        stream.start_stream()
                except Exception:
                    pass

            adjust = _consume_pause_adjustment()
            if adjust > 0:
                start_t += adjust

            data = stream.read(args.chunk, exception_on_overflow=False)
            wf.writeframes(data)

            audio_i16 = np.frombuffer(data, dtype=np.int16)
            if audio_i16.size == 0:
                continue
            audio_f32 = audio_i16.astype(np.float32) / 32768.0
            speech_prob = _vad_prob(vad_model, audio_f32, args.rate)
            is_speech = speech_prob >= args.vad_threshold

            if not speaking:
                pre_buffer.append(audio_i16)
                if is_speech:
                    speech_run += 1
                else:
                    speech_run = 0
                if speech_run >= min_speech_frames:
                    speaking = True
                    utterance_frames = list(pre_buffer)
                    pre_buffer.clear()
                    silence_buffer = []
            else:
                if is_speech:
                    if silence_buffer:
                        utterance_frames.extend(silence_buffer)
                        silence_buffer = []
                    utterance_frames.append(audio_i16)
                else:
                    silence_buffer.append(audio_i16)
                    if len(silence_buffer) >= min_silence_frames:
                        if post_pad_frames > 0:
                            utterance_frames.extend(silence_buffer[:post_pad_frames])
                        finalize_utterance(utterance_frames)
                        tail = silence_buffer[-pre_pad_frames:] if pre_pad_frames > 0 else []
                        pre_buffer = collections.deque(tail, maxlen=pre_pad_frames or 1)
                        silence_buffer = []
                        utterance_frames = []
                        speaking = False
                        speech_run = 0

            elapsed = time.time() - start_t
            if elapsed - last_print >= 1.0:
                last_print = elapsed
                print(f"[record] seconds={int(elapsed)}", flush=True)

    finally:
        try:
            stream.stop_stream()
            stream.close()
        except Exception:
            pass
        try:
            pa.terminate()
        except Exception:
            pass
        try:
            wf.close()
        except Exception:
            pass

    if silence_buffer and utterance_frames:
        if post_pad_frames > 0:
            utterance_frames.extend(silence_buffer[:post_pad_frames])
    if utterance_frames:
        finalize_utterance(utterance_frames)

    utterance_queue.put(None)
    utterance_queue.join()
    worker.join(timeout=2.0)

    with transcript_lock:
        full_text = "\n".join([t for t in transcript_parts if t])
    try:
        _write_transcript(transcript_path, full_text)
    except Exception as e:
        print(f"[transcribe] failed to write transcript: {e}", file=sys.stderr, flush=True)

    print(json.dumps({"event": "done", "out": transcript_path, "text": full_text}), flush=True)
    print("[record] STOP", flush=True)
    sys.exit(0)


if __name__ == "__main__":
    main()
