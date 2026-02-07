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
        import torch 
        import torchaudio  
        import whisper  
        import pyaudio 
        import llama_cpp 
    except Exception as exc:
        emit("error", f"dependency import failed: {exc}")
        sys.exit(2)


def ensure_whisper_model(model_name: str, download_root: str = None):
    emit("status", f"downloading whisper model {model_name}")
    try:
        import whisper
    except Exception as exc:
        emit("error", f"failed to import whisper: {exc}")
        sys.exit(3)

    model_file = None
    if download_root:
        model_file = os.path.join(download_root, f"{model_name}.pt")
        if os.path.exists(model_file):
            emit("status", f"whisper model already present: {model_name}")
            return

    try:
        whisper.load_model(model_name, download_root=download_root)
    except Exception as exc:
        emit("error", f"whisper download failed: {exc}")
        sys.exit(4)

    if model_file and not os.path.exists(model_file):
        emit("error", f"whisper model not found after download: {model_file}")
        sys.exit(5)


def ensure_vad_model():
    emit("status", "loading silero VAD model")
    try:
        import torch
    except Exception as exc:
        emit("error", f"failed to import torch: {exc}")
        sys.exit(6)

    try:
        torch.hub.load(
            repo_or_dir="snakers4/silero-vad",
            model="silero_vad",
            trust_repo=True,
            force_reload=False,
        )
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
