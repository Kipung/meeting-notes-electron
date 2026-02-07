#!/usr/bin/env python3
"""
Transcribe an existing audio recording and output JSON events so the Electron UI can reuse the existing pipeline.

Usage:
  Set the environment variables below instead of passing CLI flags:
    TRANSCRIBE_AUDIO=/path/to/audio.wav
    TRANSCRIPT_OUT=/path/to/transcript.txt   # optional (defaults next to the audio)
    TRANSCRIBE_MODEL=small.en                 # optional (defaults to small.en)

Emits:
  {"event":"ready"}
  {"event":"started","out":"...","transcript_out":"..."}
  {"event":"done","out":"...","text":"..."}
  {"event":"error","msg":"..."}
"""

import json
import os
import sys

try:
    import torch
except ImportError:
    torch = None  # whisper will raise if torch is missing

try:
    import whisper
except Exception as e:
    print(json.dumps({"event": "error", "msg": f"failed to import whisper: {e}"}))
    sys.exit(1)


def send(obj: dict):
    print(json.dumps(obj), flush=True)


def load_model(model_name: str):
    device = "cuda" if torch and torch.cuda.is_available() else "cpu"
    download_root = os.environ.get("WHISPER_ROOT")
    return whisper.load_model(model_name, device=device, download_root=download_root)


def main():
    model_name = os.getenv("TRANSCRIBE_MODEL", "small.en")
    audio_path = os.getenv("TRANSCRIBE_AUDIO")
    if not audio_path:
        send({"event": "error", "msg": "TRANSCRIBE_AUDIO not configured"})
        sys.exit(2)
    if not os.path.exists(audio_path):
        send({"event": "error", "msg": f"audio file not found: {audio_path}"})
        sys.exit(2)
    transcript_out = os.getenv("TRANSCRIPT_OUT")
    if not transcript_out:
        transcript_out = os.path.join(os.path.dirname(audio_path), "transcript.txt")
    os.makedirs(os.path.dirname(transcript_out) or ".", exist_ok=True)

    send({"event": "ready"})
    try:
        whisper_model = load_model(model_name)
    except Exception as e:
        send({"event": "error", "msg": f"failed to load model {model_name}: {e}"})
        sys.exit(3)

    send({"event": "started", "out": audio_path, "transcript_out": transcript_out})
    try:
        result = whisper_model.transcribe(audio_path, language="en", task="transcribe", fp16=False)
        text = result.get("text", "").strip()
        with open(transcript_out, "w", encoding="utf-8") as f:
            f.write(text)
        send({"event": "done", "out": transcript_out, "text": text})
    except Exception as e:
        send({"event": "error", "msg": f"transcription failed: {e}"})
        sys.exit(4)


if __name__ == "__main__":
    main()
