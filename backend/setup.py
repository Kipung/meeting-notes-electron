import json
import os
import sys


def emit(event: str, message: str, **fields):
    payload = {"event": event, "message": message}
    payload.update(fields)
    print(json.dumps(payload), flush=True)


def check_imports():
    emit("status", "checking python dependencies")
    try:
        import faster_whisper  
        import silero_vad  
        import onnxruntime  
        import pyaudio 
        import llama_cpp 
    except Exception as exc:
        emit("error", f"dependency import failed: {exc}")
        sys.exit(2)


def ensure_whisper_model(model_name: str, download_root: str = None):
    emit("status", f"downloading faster-whisper model {model_name}")
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        emit("error", f"failed to import faster-whisper: {exc}")
        sys.exit(3)

    try:
        try:
            WhisperModel(
                model_name,
                device="cuda",
                compute_type="float16",
                download_root=download_root,
            )
        except Exception:
            WhisperModel(
                model_name,
                device="cpu",
                compute_type="int8",
                download_root=download_root,
            )
    except Exception as exc:
        emit("error", f"faster-whisper download failed: {exc}")
        sys.exit(4)


def ensure_vad_model():
    emit("status", "loading silero VAD model (onnxruntime)")
    try:
        from silero_vad import load_silero_vad
        load_silero_vad(onnx=True, opset_version=16)
    except Exception as exc:
        emit("error", f"vad model load failed: {exc}")
        sys.exit(7)


def main():
    whisper_model = os.getenv("WHISPER_MODEL", "small.en")
    whisper_dir = os.getenv("WHISPER_DIR", "").strip() or None
    if whisper_dir:
        os.makedirs(whisper_dir, exist_ok=True)

    check_imports()
    ensure_whisper_model(whisper_model, whisper_dir)
    ensure_vad_model()
    emit("done", "setup complete")


if __name__ == "__main__":
    main()
