import json
import os
import sys
from pathlib import Path


def emit(event: str, message: str, **fields):
    payload = {"event": event, "message": message}
    payload.update(fields)
    print(json.dumps(payload), flush=True)


def check_imports():
    emit("status", "checking python dependencies")
    try:
        import faster_whisper  
        import onnxruntime
        if sys.platform == "win32":
            import pyaudiowpatch as pyaudio
        else:
            import pyaudio 
        import llama_cpp 
    except Exception as exc:
        emit("error", f"dependency import failed: {exc}")
        sys.exit(2)


def ensure_whisper_model(model_name: str, download_root: str = None):
    emit("status", f"downloading faster-whisper model {model_name}")
    try:
        from faster_whisper import WhisperModel
        import numpy as np
    except Exception as exc:
        emit("error", f"failed to import faster-whisper: {exc}")
        sys.exit(3)
    emit("status", f"faster-whisper download root: {download_root or 'default cache directory'}")

    last_error = None
    for device, compute_type in (("cuda", "float16"), ("cpu", "int8")):
        try:
            model = WhisperModel(
                model_name,
                device=device,
                compute_type=compute_type,
                download_root=download_root,
            )
            warmup_segments, _ = model.transcribe(np.zeros(16000, dtype=np.float32), language="en", task="transcribe")
            for _ in warmup_segments:
                pass
            return
        except Exception:
            last_error = sys.exc_info()[1]
            continue

    emit("error", f"faster-whisper download/init failed: {last_error}")
    sys.exit(4)


def _default_vad_model_path() -> str:
    return str(Path(__file__).resolve().parent.parent / "models" / "silero_vad.onnx")


def ensure_vad_model(vad_model_path: str):
    emit("status", f"loading silero VAD model via onnxruntime: {vad_model_path}")
    if not os.path.exists(vad_model_path):
        emit("error", f"silero VAD model not found: {vad_model_path}")
        sys.exit(7)
    try:
        import onnxruntime as ort
        _session = ort.InferenceSession(
            vad_model_path,
            providers=["CPUExecutionProvider"],
        )
        _session.get_inputs()
        _session.get_outputs()
    except Exception as exc:
        emit("error", f"vad model load failed: {exc}")
        sys.exit(7)


def main():
    whisper_model = os.getenv("WHISPER_MODEL", "small.en")
    whisper_dir = os.getenv("WHISPER_DIR", "").strip() or str(Path(__file__).resolve().parent.parent / "models" / "whisper")
    vad_model_path = os.getenv("SILERO_VAD_MODEL", "").strip() or _default_vad_model_path()
    if whisper_dir:
        os.makedirs(whisper_dir, exist_ok=True)

    check_imports()
    ensure_whisper_model(whisper_model, whisper_dir)
    ensure_vad_model(vad_model_path)
    emit("done", "setup complete")


if __name__ == "__main__":
    main()
