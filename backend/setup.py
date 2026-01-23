#!/usr/bin/env python3
"""
Bootstrap dependencies and download required models before recording.

Emits JSON lines to stdout for UI progress.
"""

import argparse
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
        import torch  # noqa: F401
        import torchaudio  # noqa: F401
        import whisper  # noqa: F401
        import pyaudio  # noqa: F401
        import llama_cpp  # noqa: F401
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--whisper-model", default="small.en", help="Whisper model name")
    parser.add_argument("--whisper-dir", default="", help="Whisper download directory")
    args = parser.parse_args()

    whisper_dir = args.whisper_dir.strip() or None
    if whisper_dir:
        os.makedirs(whisper_dir, exist_ok=True)

    check_imports()
    ensure_whisper_model(args.whisper_model, whisper_dir)
    emit("done", "setup complete")


if __name__ == "__main__":
    main()
