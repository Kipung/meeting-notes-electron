
import collections
import json
import os
import queue
from pathlib import Path
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
from faster_whisper import WhisperModel
try:
    from backend.recording_vad_utils import (
        frames_for_ms,
        positive_int_from_env,
        samples_for_ms,
        should_force_flush_utterance,
        take_post_pad_frames,
    )
except ImportError:
    from recording_vad_utils import (  # type: ignore[no-redef]
        frames_for_ms,
        positive_int_from_env,
        samples_for_ms,
        should_force_flush_utterance,
        take_post_pad_frames,
    )


TARGET_RATE = 16000
TARGET_CHANNELS = 1
TARGET_CHUNK = 512
VAD_THRESHOLD = 0.5
VAD_MIN_SILENCE_MS = 600
VAD_MIN_SPEECH_MS = 200
VAD_PRE_PAD_MS = 200
VAD_POST_PAD_MS = 200
VAD_MAX_UTTERANCE_MS = 8000


class SessionState:
    def __init__(self, out_path: str, transcript_path: str, stream, wf):
        self.out_path = out_path
        self.transcript_path = transcript_path
        self.stream = stream
        self.loopback_stream = None
        self.mic_channels = TARGET_CHANNELS
        self.loopback_channels = TARGET_CHANNELS
        self.mic_rate = TARGET_RATE
        self.loopback_rate = TARGET_RATE
        self.mic_chunk = TARGET_CHUNK
        self.loopback_chunk = TARGET_CHUNK
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


class SileroOnnxVad:
    def __init__(self, model_path: str):
        import onnxruntime as ort

        self.session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
        self.input_names = [inp.name for inp in self.session.get_inputs()]
        self.output_names = [out.name for out in self.session.get_outputs()]

        self.sr_name = self._find_name(self.input_names, ("sr", "sample_rate"))
        self.x_name = self._find_name(self.input_names, ("input", "x", "audio"))
        self.state_input_names = [
            name
            for name in self.input_names
            if name not in {self.x_name, self.sr_name}
        ]

        if self.x_name is None:
            raise RuntimeError("unable to identify audio input tensor for silero_vad.onnx")
        self.reset_states()

    @staticmethod
    def _find_name(candidates: list[str], expected: tuple[str, ...]) -> str | None:
        for expected_name in expected:
            for candidate in candidates:
                if candidate == expected_name:
                    return candidate
        for expected_name in expected:
            for candidate in candidates:
                if expected_name in candidate.lower():
                    return candidate
        return None

    def reset_states(self):
        self.state_inputs: dict[str, np.ndarray] = {}
        for name in self.state_input_names:
            self.state_inputs[name] = np.zeros(self._state_shape_for(name), dtype=np.float32)

    def _state_shape_for(self, name: str | None) -> tuple[int, ...]:
        if name is None:
            return (2, 1, 64)
        for inp in self.session.get_inputs():
            if inp.name != name:
                continue
            shape = []
            for dim in inp.shape:
                if isinstance(dim, int) and dim > 0:
                    shape.append(dim)
                else:
                    shape.append(1)
            if shape:
                return tuple(shape)
        return (2, 1, 64)

    def __call__(self, audio_float: np.ndarray, sample_rate: int) -> float:
        audio = np.asarray(audio_float, dtype=np.float32)
        if audio.ndim == 1:
            audio = np.expand_dims(audio, axis=0)
        elif audio.ndim > 2:
            audio = audio.reshape(1, -1)

        inputs = {self.x_name: audio}
        if self.sr_name is not None:
            inputs[self.sr_name] = np.array([sample_rate], dtype=np.int64)
        for name, value in self.state_inputs.items():
            inputs[name] = value

        outputs = self.session.run(None, inputs)
        if len(outputs) == 0:
            return 0.0

        out_by_name = {
            name: np.asarray(value, dtype=np.float32)
            for name, value in zip(self.output_names, outputs)
        }
        # Prefer named state outputs when available.
        for state_name in self.state_input_names:
            if state_name in out_by_name:
                self.state_inputs[state_name] = out_by_name[state_name]

        # Fallback for models that return unnamed/mismatched state outputs.
        if self.state_input_names:
            unnamed_state_outputs = outputs[1:]
            for idx, state_name in enumerate(self.state_input_names):
                if state_name in out_by_name:
                    continue
                if idx < len(unnamed_state_outputs):
                    self.state_inputs[state_name] = np.asarray(unnamed_state_outputs[idx], dtype=np.float32)

        prob = outputs[0]
        return float(np.asarray(prob).reshape(-1)[0])


def _write_transcript(path: str, text: str):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def _default_vad_model_path() -> str:
    return str(Path(__file__).resolve().parent.parent / "models" / "silero_vad.onnx")


def _default_whisper_root() -> str:
    return str(Path(__file__).resolve().parent.parent / "models" / "whisper")


def _vad_load():
    model_path = os.environ.get("SILERO_VAD_MODEL") or _default_vad_model_path()
    if not os.path.exists(model_path):
        print(f"[vad] silero onnx model not found: {model_path}", file=sys.stderr, flush=True)
        return None
    try:
        return SileroOnnxVad(model_path)
    except Exception as e:
        print(f"[vad] failed to load silero onnx model: {e}", file=sys.stderr, flush=True)
        return None


def _vad_prob(vad_model, audio_float: np.ndarray, sample_rate: int) -> float:
    if vad_model is None:
        return 0.0
    try:
        prob = vad_model(audio_float, sample_rate)
        return float(prob.item() if hasattr(prob, "item") else prob)
    except Exception as e:
        print(f"[vad] inference error: {e}", file=sys.stderr, flush=True)
        return 0.0


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


def _resample_to_length(audio_i16: np.ndarray, target_len: int) -> np.ndarray:
    if audio_i16.size == 0 or target_len <= 0:
        return np.array([], dtype=np.int16)
    if audio_i16.size == target_len:
        return audio_i16
    if target_len == 1:
        return audio_i16[:1]
    src_len = audio_i16.size
    src_x = np.arange(src_len, dtype=np.float32)
    dst_x = np.linspace(0, src_len - 1, num=target_len, dtype=np.float32)
    resampled = np.interp(dst_x, src_x, audio_i16.astype(np.float32))
    return np.rint(resampled).astype(np.int16)


def _mix_audio(mic_i16: np.ndarray, loop_i16: np.ndarray) -> np.ndarray:
    if mic_i16.size == 0 and loop_i16.size == 0:
        return mic_i16
    if mic_i16.size == 0:
        return loop_i16
    if loop_i16.size == 0:
        return mic_i16
    length = min(mic_i16.size, loop_i16.size)
    if length <= 0:
        return mic_i16
    mic_f = mic_i16[:length].astype(np.float32)
    loop_f = loop_i16[:length].astype(np.float32)
    mixed = 0.5 * (mic_f + loop_f)
    mixed = np.clip(mixed, -32768, 32767)
    return np.rint(mixed).astype(np.int16)


def _load_whisper_model(model_name: str, download_root: str | None):
    whisper_root = download_root or _default_whisper_root()
    device = "cpu"
    compute_type = "int8"
    try:
        model = WhisperModel(
            model_name,
            device=device,
            compute_type=compute_type,
            download_root=whisper_root,
            local_files_only=True,
        )
        # Force backend runtime initialization early so missing CUDA DLLs
        # are detected here instead of in the transcription worker thread.
        warmup_audio = np.zeros(TARGET_RATE, dtype=np.float32)
        warmup_segments, _ = model.transcribe(warmup_audio, language="en", task="transcribe")
        for _ in warmup_segments:
            pass
        return model, device, compute_type
    except Exception as e:
        print(
            f"[transcribe] failed on {device} ({compute_type}), trying fallback: {e}",
            file=sys.stderr,
            flush=True,
        )


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

    try:
        download_root = os.environ.get("WHISPER_ROOT") or _default_whisper_root()
        print(f"[transcribe] loading model {model_name} from {download_root}", flush=True)
        whisper_model, model_device, model_compute = _load_whisper_model(model_name, download_root)
        print(f"[transcribe] loading model {model_name} on {model_device} ({model_compute})", flush=True)
    except Exception as e:
        print(f"[transcribe] failed to load model: {e}", file=sys.stderr, flush=True)
        sys.exit(3)

    chunk_ms = (TARGET_CHUNK / float(TARGET_RATE)) * 1000.0
    min_silence_frames = frames_for_ms(VAD_MIN_SILENCE_MS, chunk_ms)
    min_speech_frames = frames_for_ms(VAD_MIN_SPEECH_MS, chunk_ms)
    pre_pad_frames = frames_for_ms(VAD_PRE_PAD_MS, chunk_ms)
    post_pad_frames = frames_for_ms(VAD_POST_PAD_MS, chunk_ms)
    min_utterance_samples = samples_for_ms(VAD_MIN_SPEECH_MS, TARGET_RATE)
    max_utterance_ms = positive_int_from_env(os.environ.get("VAD_MAX_UTTERANCE_MS"), VAD_MAX_UTTERANCE_MS)
    max_utterance_samples = samples_for_ms(max_utterance_ms, TARGET_RATE)

    session_lock = threading.Lock()
    current_session = {"state": None}
    shutdown_event = threading.Event()

    def send(obj):
        print(json.dumps(obj), flush=True)

    send({"event": "ready"})

    def start_session(out_path: str, transcript_path: str, device_index, loopback_device_index):
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
            loopback_stream = None
            loopback_rate = TARGET_RATE
            loopback_channels = TARGET_CHANNELS
            loopback_chunk = TARGET_CHUNK
            if loopback_device_index is not None:
                try:
                    loopback_info = pa.get_device_info_by_index(loopback_device_index)
                except Exception as e:
                    send({"event": "error", "msg": f"failed to get loopback device info: {e}"})
                    try:
                        stream.stop_stream()
                        stream.close()
                    except Exception:
                        pass
                    return
                loopback_rate = int(loopback_info.get("defaultSampleRate", TARGET_RATE))
                loopback_channels = 2 if loopback_info.get("maxInputChannels", 0) >= 2 else 1
                loopback_min_chunk = int(np.ceil(loopback_rate / 31.25))
                loopback_chunk = max(loopback_min_chunk, int(np.ceil(loopback_rate * (TARGET_CHUNK / float(TARGET_RATE)))))
                loopback_kwargs = dict(
                    format=pyaudio.paInt16,
                    channels=loopback_channels,
                    rate=loopback_rate,
                    input=True,
                    frames_per_buffer=loopback_chunk,
                    input_device_index=loopback_device_index,
                )
                try:
                    if sys.platform == "win32":
                        loopback_kwargs["as_loopback"] = True
                    loopback_stream = pa.open(**loopback_kwargs)
                except Exception as e:
                    if sys.platform == "win32" and "as_loopback" in loopback_kwargs:
                        try:
                            loopback_kwargs.pop("as_loopback", None)
                            loopback_stream = pa.open(**loopback_kwargs)
                        except Exception as e2:
                            send({"event": "error", "msg": f"failed to open loopback stream: {e2}"})
                            try:
                                stream.stop_stream()
                                stream.close()
                            except Exception:
                                pass
                            return
                    else:
                        send({"event": "error", "msg": f"failed to open loopback stream: {e}"})
                        try:
                            stream.stop_stream()
                            stream.close()
                        except Exception:
                            pass
                        return
            sample_width = pa.get_sample_size(pyaudio.paInt16)
            wf = wave.open(out_path, "wb")
            wf.setnchannels(TARGET_CHANNELS)
            wf.setsampwidth(sample_width)
            wf.setframerate(TARGET_RATE)
            state = SessionState(out_path, transcript_path, stream, wf)
            state.loopback_stream = loopback_stream
            state.mic_channels = capture_channels
            state.loopback_channels = loopback_channels
            state.mic_rate = capture_rate
            state.loopback_rate = loopback_rate
            state.mic_chunk = input_chunk
            state.loopback_chunk = loopback_chunk
            state.pre_buffer = collections.deque(maxlen=pre_pad_frames or None)
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
                        segments, _info = whisper_model.transcribe(
                            audio_f32,
                            language="en",
                            task="transcribe",
                        )
                        text = " ".join(segment.text.strip() for segment in segments if segment.text).strip()
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
        if audio_i16.size == 0:
            return
        if audio_i16.size >= min_utterance_samples:
            state.utterance_queue.put(audio_i16)

    def finish_active_utterance(state: SessionState):
        if state.silence_buffer and state.utterance_frames:
            state.utterance_frames.extend(take_post_pad_frames(state.silence_buffer, post_pad_frames))
        finalize_utterance(state, state.utterance_frames)
        state.pre_buffer.clear()
        state.silence_buffer = []
        state.utterance_frames = []
        state.speaking = False
        state.speech_run = 0

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
                    if state.loopback_stream is not None:
                        try:
                            if state.loopback_stream.is_active():
                                state.loopback_stream.stop_stream()
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
                    if state.loopback_stream is not None:
                        try:
                            if not state.loopback_stream.is_active():
                                state.loopback_stream.start_stream()
                        except Exception:
                            pass

                try:
                    mic_data = state.stream.read(state.mic_chunk, exception_on_overflow=False)
                except Exception as _read_err:
                    send({"event": "error", "msg": f"recording error: {_read_err}"})
                    state.stop_event.set()
                    break

                try:
                    mic_i16 = np.frombuffer(mic_data, dtype=np.int16)
                    mic_i16 = _downmix_to_mono(mic_i16, state.mic_channels)
                    mic_i16 = _resample_linear(mic_i16, state.mic_rate, TARGET_RATE)

                    loop_i16 = np.array([], dtype=np.int16)
                    if state.loopback_stream is not None:
                        try:
                            available = state.loopback_stream.get_read_available()
                        except Exception:
                            available = state.loopback_chunk
                        if available > 0:
                            try:
                                frames = min(available, state.loopback_chunk)
                                loop_data = state.loopback_stream.read(frames, exception_on_overflow=False)
                                loop_i16 = np.frombuffer(loop_data, dtype=np.int16)
                                loop_i16 = _downmix_to_mono(loop_i16, state.loopback_channels)
                                loop_i16 = _resample_linear(loop_i16, state.loopback_rate, TARGET_RATE)
                                if mic_i16.size > 0 and loop_i16.size > 0 and loop_i16.size != mic_i16.size:
                                    loop_i16 = _resample_to_length(loop_i16, mic_i16.size)
                            except Exception:
                                loop_i16 = np.array([], dtype=np.int16)

                    audio_i16 = _mix_audio(mic_i16, loop_i16)
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
                                finish_active_utterance(state)

                        if state.speaking and should_force_flush_utterance(state.utterance_frames, max_utterance_samples):
                            finish_active_utterance(state)

                    elapsed = time.time() - state.start_t
                    if elapsed - state.last_print >= 1.0:
                        state.last_print = elapsed
                        print(f"[record] seconds={int(elapsed)}", flush=True)
                except Exception as _proc_err:
                    send({"event": "error", "msg": f"audio processing error: {_proc_err}"})
                    state.stop_event.set()
                    break

            try:
                state.stream.stop_stream()
                state.stream.close()
            except Exception:
                pass
            if state.loopback_stream is not None:
                try:
                    state.loopback_stream.stop_stream()
                    state.loopback_stream.close()
                except Exception:
                    pass
            try:
                state.wf.close()
            except Exception:
                pass

            if state.utterance_frames:
                finish_active_utterance(state)

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
            loopback_device_index = payload.get("loopback_device_index")
            print(
                f"[record] start command received: out={out_path}, transcript_out={transcript_path}, device_index={device_index}, loopback_device_index={loopback_device_index}",
                flush=True,
            )
            if not out_path:
                send({"event": "error", "msg": "missing out path"})
                return
            if not transcript_path:
                transcript_path = os.path.join(os.path.dirname(out_path), "transcript.txt")
            loopback_value = loopback_device_index if isinstance(loopback_device_index, int) else None
            start_session(out_path, transcript_path, device_index if isinstance(device_index, int) else None, loopback_value)
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
