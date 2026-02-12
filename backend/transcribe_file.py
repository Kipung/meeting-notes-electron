import json
import os
import sys

try:
    from faster_whisper import WhisperModel
except Exception as e:
    print(json.dumps({"event": "error", "msg": f"failed to import faster-whisper: {e}"}))
    sys.exit(1)


def send(obj: dict):
    print(json.dumps(obj), flush=True)


def load_model(model_name: str):
    download_root = os.environ.get("WHISPER_ROOT")
    try:
        return WhisperModel(
            model_name,
            device="cuda",
            compute_type="float16",
            download_root=download_root,
        )
    except Exception:
        return WhisperModel(
            model_name,
            device="cpu",
            compute_type="int8",
            download_root=download_root,
        )


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
        segments, _info = whisper_model.transcribe(audio_path, language="en", task="transcribe")
        text = " ".join(segment.text.strip() for segment in segments if segment.text).strip()
        with open(transcript_out, "w", encoding="utf-8") as f:
            f.write(text)
        send({"event": "done", "out": transcript_out, "text": text})
    except Exception as e:
        send({"event": "error", "msg": f"transcription failed: {e}"})
        sys.exit(4)


if __name__ == "__main__":
    main()
