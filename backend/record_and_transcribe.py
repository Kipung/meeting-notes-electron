#!/usr/bin/env python3
"""
Persistent recorder with Silero VAD + Whisper transcription.

Protocol (stdin JSON lines or plain commands):
  {"cmd":"start","out":"/path/audio.wav","transcript_out":"/path/transcript.txt","device_index":1}
  {"cmd":"stop"}
  {"cmd":"pause"}
  {"cmd":"resume"}
  {"cmd":"shutdown"}

Emits JSON on stdout:
  {"event":"started","out":"...","transcript_out":"..."}
  {"event":"done","out":"...","text":"..."}
  {"event":"error","msg":"..."}
"""

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
if sys.platform == "win32":
    import pyaudiowpatch as pyaudio
else:
    import pyaudio
import torch
import whisper


TARGET_RATE = 16000
TARGET_CHANNELS = 1
TARGET_CHUNK = 512
VAD_THRESHOLD = 0.5
VAD_MIN_SILENCE_MS = 600
VAD_MIN_SPEECH_MS = 200
VAD_PRE_PAD_MS = 200
VAD_POST_PAD_MS = 200


class SessionState:
    def __init__(self, out_path: str, transcript_path: str, stream, wf):
        self.out_path = out_path
        self.transcript_path = transcript_path
        self.stream = stream
        self.wf = wf
        self.pre_buffer = collections.deque()
        self.silence_buffer = []
        self.utterance_frames = []
        self.speech_run = 0
        self.speaking = False
        self.start_t = time.time()
        self.last_print = 0.0
        self.paused = False
        self.stop_event = threading.Event()
        self.done_event = threading.Event()
        self.transcript_parts = []
        self.transcript_lock = threading.Lock()
        self.utterance_queue = queue.Queue()
        self.worker = None


def _write_transcript(path: str, text: str):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


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


def _downmix_to_mono(audio_i16: np.ndarray, channels: int) -> np.ndarray:
    if channels <= 1 or audio_i16.size == 0:
        return audio_i16
    remainder = audio_i16.size % channels
    if remainder:
        audio_i16 = audio_i16[: audio_i16.size - remainder]
    frames = audio_i16.reshape(-1, channels).astype(np.float32)
    return np.rint(frames.mean(axis=1)).astype(np.int16)


def _resample_linear(audio_i16: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    if src_rate == dst_rate or audio_i16.size == 0:
        return audio_i16
    src_len = audio_i16.size
    dst_len = int(round(src_len * float(dst_rate) / float(src_rate)))
    if dst_len <= 1:
        return audio_i16[:1]
    src_x = np.arange(src_len, dtype=np.float32)
    dst_x = np.linspace(0, src_len - 1, num=dst_len, dtype=np.float32)
    resampled = np.interp(dst_x, src_x, audio_i16.astype(np.float32))
    return np.rint(resampled).astype(np.int16)


def main():
    model_name = "small.en"
    if "--model" in sys.argv:
        idx = sys.argv.index("--model")
        if idx + 1 < len(sys.argv):
            model_name = sys.argv[idx + 1]
    pa = pyaudio.PyAudio()
    capture_channels = TARGET_CHANNELS
    capture_rate = TARGET_RATE
    input_chunk = TARGET_CHUNK

    vad_model = _vad_load()
    if vad_model is None:
        print("[record] VAD model failed to load, exiting", file=sys.stderr, flush=True)
        sys.exit(5)
    if hasattr(vad_model, "reset_states"):
        vad_model.reset_states()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[transcribe] loading model {model_name} on {device}", flush=True)
    try:
        download_root = os.environ.get("WHISPER_ROOT")
        whisper_model = whisper.load_model(model_name, device=device, download_root=download_root)
    except Exception as e:
        print(f"[transcribe] failed to load model: {e}", file=sys.stderr, flush=True)
        sys.exit(3)

    chunk_ms = (TARGET_CHUNK / float(TARGET_RATE)) * 1000.0
    pre_pad_frames = max(0, int(VAD_PRE_PAD_MS / chunk_ms)) if chunk_ms > 0 else 0
    post_pad_frames = max(0, int(VAD_POST_PAD_MS / chunk_ms)) if chunk_ms > 0 else 0
    min_silence_frames = max(1, int(VAD_MIN_SILENCE_MS / chunk_ms)) if chunk_ms > 0 else 1
    min_speech_frames = max(1, int(VAD_MIN_SPEECH_MS / chunk_ms)) if chunk_ms > 0 else 1
    min_utterance_samples = int((VAD_MIN_SPEECH_MS / 1000.0) * TARGET_RATE)

    session_lock = threading.Lock()
    current_session = {"state": None}
    shutdown_event = threading.Event()

    def send(obj):
        print(json.dumps(obj), flush=True)

    send({"event": "ready"})

    def start_session(out_path: str, transcript_path: str, device_index):
        nonlocal capture_channels, capture_rate, input_chunk
        device_info = pa.get_device_info_by_index(device_index) if device_index is not None else pa.get_default_input_device_info()
        capture_rate = int(device_info.get("defaultSampleRate", TARGET_RATE))
        min_chunk = int(np.ceil(capture_rate / 31.25))
        input_chunk = max(min_chunk, int(np.ceil(capture_rate * (TARGET_CHUNK / float(TARGET_RATE)))))
        capture_channels = int(device_info.get("maxInputChannels", TARGET_CHANNELS)) or TARGET_CHANNELS
        with session_lock:
            if current_session["state"] is not None:
                send({"event": "error", "msg": "session already running"})
                return
            os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)

            stream_kwargs = dict(
                format=pyaudio.paInt16,
                channels=capture_channels,
                rate=capture_rate,
                input=True,
                frames_per_buffer=input_chunk,
            )
            if device_index is not None:
                stream_kwargs["input_device_index"] = device_index
            try:
                stream = pa.open(**stream_kwargs)
            except Exception as e:
                if capture_channels > 1:
                    try:
                        stream_kwargs["channels"] = 1
                        stream = pa.open(**stream_kwargs)
                        capture_channels = 1
                    except Exception:
                        send({"event": "error", "msg": f"failed to open input stream: {e}"})
                        return
                else:
                    send({"event": "error", "msg": f"failed to open input stream: {e}"})
                    return
            sample_width = pa.get_sample_size(pyaudio.paInt16)
            wf = wave.open(out_path, "wb")
            wf.setnchannels(TARGET_CHANNELS)
            wf.setsampwidth(sample_width)
            wf.setframerate(TARGET_RATE)
            state = SessionState(out_path, transcript_path, stream, wf)
            state.pre_buffer = collections.deque(maxlen=pre_pad_frames or 1)
            if hasattr(vad_model, "reset_states"):
                vad_model.reset_states()
            current_session["state"] = state

            def transcribe_worker():
                while True:
                    item = state.utterance_queue.get()
                    try:
                        if item is None:
                            return
                        audio_i16 = item
                        audio_f32 = audio_i16.astype(np.float32) / 32768.0
                        result = whisper_model.transcribe(audio_f32, language="en", task="transcribe", fp16=False)
                        text = result.get("text", "").strip()
                        if text:
                            with state.transcript_lock:
                                state.transcript_parts.append(text)
                                full_text = "\n".join([t for t in state.transcript_parts if t])
                            send({"event": "partial", "text": text, "full_text": full_text})
                    except Exception as e:
                        print(f"[transcribe] utterance error: {e}", file=sys.stderr, flush=True)
                    finally:
                        state.utterance_queue.task_done()

            state.worker = threading.Thread(target=transcribe_worker, daemon=True)
            state.worker.start()
            send({"event": "started", "out": out_path, "transcript_out": transcript_path, "started_at": state.start_t})

    def stop_session(emit_error: bool = True):
        with session_lock:
            state = current_session["state"]
            if state is None:
                if emit_error:
                    send({"event": "error", "msg": "no active session"})
                return
            state.stop_event.set()
        state.done_event.wait(timeout=30)

    def pause_session():
        with session_lock:
            state = current_session["state"]
            if state:
                state.paused = True

    def resume_session():
        with session_lock:
            state = current_session["state"]
            if state:
                state.paused = False

    def finalize_utterance(state: SessionState, frames: list[np.ndarray]):
        if not frames:
            return
        audio_i16 = np.concatenate(frames)
        if audio_i16.size < min_utterance_samples:
            return
        state.utterance_queue.put(audio_i16)

    def recording_loop():
        while not shutdown_event.is_set():
            with session_lock:
                state = current_session["state"]
            if state is None:
                time.sleep(0.05)
                continue

            while not state.stop_event.is_set() and not shutdown_event.is_set():
                if state.paused:
                    try:
                        if state.stream.is_active():
                            state.stream.stop_stream()
                    except Exception:
                        pass
                    if hasattr(vad_model, "reset_states"):
                        vad_model.reset_states()
                    state.pre_buffer.clear()
                    state.silence_buffer.clear()
                    state.utterance_frames.clear()
                    state.speaking = False
                    state.speech_run = 0
                    time.sleep(0.05)
                    continue
                else:
                    try:
                        if not state.stream.is_active():
                            state.stream.start_stream()
                    except Exception:
                        pass

                data = state.stream.read(input_chunk, exception_on_overflow=False)
                audio_i16 = np.frombuffer(data, dtype=np.int16)
                audio_i16 = _downmix_to_mono(audio_i16, capture_channels)
                audio_i16 = _resample_linear(audio_i16, capture_rate, TARGET_RATE)
                if audio_i16.size:
                    state.wf.writeframes(audio_i16.tobytes())

                if audio_i16.size == 0:
                    continue
                audio_f32 = audio_i16.astype(np.float32) / 32768.0
                speech_prob = _vad_prob(vad_model, audio_f32, TARGET_RATE)
                is_speech = speech_prob >= VAD_THRESHOLD

                if not state.speaking:
                    state.pre_buffer.append(audio_i16)
                    if is_speech:
                        state.speech_run += 1
                    else:
                        state.speech_run = 0
                    if state.speech_run >= min_speech_frames:
                        state.speaking = True
                        state.utterance_frames = list(state.pre_buffer)
                        state.pre_buffer.clear()
                        state.silence_buffer = []
                else:
                    if is_speech:
                        if state.silence_buffer:
                            state.utterance_frames.extend(state.silence_buffer)
                            state.silence_buffer = []
                        state.utterance_frames.append(audio_i16)
                    else:
                        state.silence_buffer.append(audio_i16)
                        if len(state.silence_buffer) >= min_silence_frames:
                            if post_pad_frames > 0:
                                state.utterance_frames.extend(state.silence_buffer[:post_pad_frames])
                            finalize_utterance(state, state.utterance_frames)
                            tail = state.silence_buffer[-pre_pad_frames:] if pre_pad_frames > 0 else []
                            state.pre_buffer = collections.deque(tail, maxlen=pre_pad_frames or 1)
                            state.silence_buffer = []
                            state.utterance_frames = []
                            state.speaking = False
                            state.speech_run = 0

                elapsed = time.time() - state.start_t
                if elapsed - state.last_print >= 1.0:
                    state.last_print = elapsed
                    print(f"[record] seconds={int(elapsed)}", flush=True)

            try:
                state.stream.stop_stream()
                state.stream.close()
            except Exception:
                pass
            try:
                state.wf.close()
            except Exception:
                pass

            if state.silence_buffer and state.utterance_frames:
                if post_pad_frames > 0:
                    state.utterance_frames.extend(state.silence_buffer[:post_pad_frames])
            if state.utterance_frames:
                finalize_utterance(state, state.utterance_frames)

            state.utterance_queue.put(None)
            state.utterance_queue.join()
            if state.worker:
                state.worker.join(timeout=2.0)

            with state.transcript_lock:
                full_text = "\n".join([t for t in state.transcript_parts if t])
            try:
                _write_transcript(state.transcript_path, full_text)
            except Exception as e:
                print(f"[transcribe] failed to write transcript: {e}", file=sys.stderr, flush=True)

            send({"event": "done", "out": state.transcript_path, "text": full_text})

            with session_lock:
                if current_session["state"] is state:
                    current_session["state"] = None
            state.done_event.set()

        try:
            pa.terminate()
        except Exception:
            pass

    def handle_command(line: str):
        raw = line.strip()
        if not raw:
            return
        cmd = None
        payload = {}
        try:
            obj = json.loads(raw)
            if isinstance(obj, dict):
                cmd = obj.get("cmd")
                payload = obj
        except Exception:
            cmd = raw.lower()
        if cmd == "start":
            out_path = payload.get("out")
            transcript_path = payload.get("transcript_out")
            device_index = payload.get("device_index")
            print(f"[record] start command received: out={out_path}, transcript_out={transcript_path}, device_index={device_index}", flush=True)
            if not out_path:
                send({"event": "error", "msg": "missing out path"})
                return
            if not transcript_path:
                transcript_path = os.path.join(os.path.dirname(out_path), "transcript.txt")
            start_session(out_path, transcript_path, device_index if isinstance(device_index, int) else None)
        elif cmd == "stop":
            stop_session()
        elif cmd == "pause":
            pause_session()
        elif cmd == "resume":
            resume_session()
        elif cmd == "shutdown":
            shutdown_event.set()
            stop_session(emit_error=False)
        else:
            send({"event": "error", "msg": f"unknown cmd: {cmd}"})

    def _handle_signal(signum, frame):
        shutdown_event.set()
        stop_session(emit_error=False)

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    rec_thread = threading.Thread(target=recording_loop, daemon=True)
    rec_thread.start()

    for line in sys.stdin:
        handle_command(line)
        if shutdown_event.is_set():
            break

    rec_thread.join(timeout=5.0)


if __name__ == "__main__":
    main()
