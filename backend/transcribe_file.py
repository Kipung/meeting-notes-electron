#!/usr/bin/env python3
"""
Transcribe an existing audio recording and output JSON events so the Electron UI can reuse the existing pipeline.

Usage:
  python3 backend/transcribe_file.py --audio /path/to/audio.wav --transcript-out /path/to/transcript.txt --model small.en

Emits:
  {"event":"ready"}
  {"event":"started","out":"...","transcript_out":"..."}
  {"event":"done","out":"...","text":"..."}
  {"event":"error","msg":"..."}
"""

import argparse
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
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="small.en")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--transcript-out", dest="transcript_out")
    args = parser.parse_args()

    audio_path = args.audio
    if not os.path.exists(audio_path):
        send({"event": "error", "msg": f"audio file not found: {audio_path}"})
        sys.exit(2)
    transcript_out = args.transcript_out or os.path.join(os.path.dirname(audio_path), "transcript.txt")
    os.makedirs(os.path.dirname(transcript_out) or ".", exist_ok=True)

    send({"event": "ready"})
    try:
        model = load_model(args.model)
    except Exception as e:
        send({"event": "error", "msg": f"failed to load model {args.model}: {e}"})
        sys.exit(3)

    send({"event": "started", "out": audio_path, "transcript_out": transcript_out})
    try:
        result = model.transcribe(audio_path, language="en", task="transcribe", fp16=False)
        text = result.get("text", "").strip()
        with open(transcript_out, "w", encoding="utf-8") as f:
            f.write(text)
        send({"event": "done", "out": transcript_out, "text": text})
    except Exception as e:
        send({"event": "error", "msg": f"transcription failed: {e}"})
        sys.exit(4)


if __name__ == "__main__":
    main()
