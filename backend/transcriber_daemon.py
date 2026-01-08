#!/usr/bin/env python3
"""
Persistent transcriber daemon that preloads a Whisper model and accepts JSON
commands on stdin to transcribe WAV files.

Protocol (stdin JSON lines):
  {"cmd":"transcribe", "wav":"/path/to/audio.wav", "out":"/path/to/transcript.txt"}
  {"cmd":"load_model", "model":"small.en"}

Responses are printed as JSON lines to stdout, e.g.:
  {"event":"loaded","model":"small.en"}
  {"event":"progress","msg":"..."}
  {"event":"done","out":"...","text":"..."}

This avoids reloading the model on every transcription request.
"""

import argparse
import json
import os
import sys
import threading
import time

try:
    import torch
    import whisper
except Exception as e:
    print(json.dumps({"event": "error", "msg": f"failed to import: {e}"}))
    sys.exit(1)


class TranscriberDaemon:
    def __init__(self, model_name: str):
        self.model_name = model_name
        self.model = None
        self.lock = threading.Lock()
        self.load_model(model_name)

    def send(self, obj):
        print(json.dumps(obj), flush=True)

    def load_model(self, model_name: str):
        with self.lock:
            device = "cuda" if torch.cuda.is_available() else "cpu"
            try:
                self.send({"event": "progress", "msg": f"loading model {model_name} on {device}"})
                download_root = os.environ.get("WHISPER_ROOT")
                self.model = whisper.load_model(model_name, device=device, download_root=download_root)
                self.model_name = model_name
                self.device = device
                self.send({"event": "loaded", "model": model_name})
            except Exception as e:
                self.send({"event": "error", "msg": f"failed to load model: {e}"})

    def transcribe(self, wav_path: str, out_path: str):
        with self.lock:
            if not os.path.exists(wav_path):
                self.send({"event": "error", "msg": f"wav not found: {wav_path}", "out": out_path})
                return
            start = time.time()
            try:
                self.send({"event": "progress", "msg": f"transcribing {wav_path}"})
                use_fp16 = self.device == "cuda"
                result = self.model.transcribe(wav_path, language="en", task="transcribe", fp16=use_fp16)
                text = result.get("text", "").strip()
            except Exception as e:
                self.send({"event": "error", "msg": f"transcription error: {e}", "out": out_path})
                return
            dur = time.time() - start
            try:
                os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
                with open(out_path, "w", encoding="utf-8") as f:
                    f.write(text)
            except Exception as e:
                self.send({"event": "error", "msg": f"failed to write out: {e}", "out": out_path})
                return

            self.send({"event": "done", "out": out_path, "text": text, "secs": dur})


def repl_loop(daemon: TranscriberDaemon):
    buf = ""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception as e:
            daemon.send({"event": "error", "msg": f"invalid json: {e}", "raw": line})
            continue

        cmd = obj.get("cmd")
        if cmd == "transcribe":
            wav = obj.get("wav")
            out = obj.get("out")
            if not wav or not out:
                daemon.send({"event": "error", "msg": "missing wav/out in transcribe command"})
                continue
            daemon.transcribe(wav, out)
        elif cmd == "load_model":
            m = obj.get("model")
            if m:
                daemon.load_model(m)
        else:
            daemon.send({"event": "error", "msg": f"unknown cmd: {cmd}", "raw": obj})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="small.en")
    args = parser.parse_args()

    daemon = TranscriberDaemon(args.model)
    repl_loop(daemon)


if __name__ == "__main__":
    main()
