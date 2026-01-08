#!/usr/bin/env python3
"""
Transcribe a WAV file using OpenAI Whisper and save transcript to an output file.

Usage:
  python3 transcribe.py --wav /path/to/audio.wav --model small.en --out /path/to/transcript.txt

This script prints progress to stdout/stderr so the Electron main process can capture it.
"""

import argparse
import os
import sys
import time

import torch
import whisper


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--wav", required=True, help="Input WAV file")
    parser.add_argument("--model", default="small.en", help="Whisper model name")
    parser.add_argument("--out", required=True, help="Output transcript path")
    args = parser.parse_args()

    wav = args.wav
    out = args.out
    model_name = args.model

    if not os.path.exists(wav):
        print(f"[transcribe] input WAV not found: {wav}", file=sys.stderr)
        sys.exit(2)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[transcribe] loading model {model_name} on {device}", flush=True)
    try:
        download_root = os.environ.get("WHISPER_ROOT")
        model = whisper.load_model(model_name, device=device, download_root=download_root)
    except Exception as e:
        print(f"[transcribe] failed to load model: {e}", file=sys.stderr, flush=True)
        sys.exit(3)

    print(f"[transcribe] transcribing {wav} ...", flush=True)
    start = time.time()
    try:
        use_fp16 = device == "cuda"
        result = model.transcribe(wav, language="en", task="transcribe", fp16=use_fp16)
        text = result.get("text", "").strip()
    except Exception as e:
        print(f"[transcribe] transcription error: {e}", file=sys.stderr, flush=True)
        text = ""

    duration = time.time() - start
    print(f"[transcribe] done in {duration:.1f}s", flush=True)

    try:
        os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
        with open(out, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"[transcribe] wrote {out}", flush=True)
    except Exception as e:
        print(f"[transcribe] failed to write output: {e}", file=sys.stderr, flush=True)
        sys.exit(4)

    # Also print the transcript to stdout for immediate consumption
    print(text)


if __name__ == "__main__":
    main()
