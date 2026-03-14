import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend import transcribe_file


class TranscribeFileTests(unittest.TestCase):
    def test_smoke_mode_writes_transcript_without_loading_model(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            audio_path = Path(tmpdir) / "input.wav"
            transcript_path = Path(tmpdir) / "transcript.txt"
            audio_path.write_bytes(b"RIFF")
            events: list[dict] = []

            with mock.patch.dict(
                os.environ,
                {
                    "MEETING_NOTES_SMOKE_MODE": "1",
                    "MEETING_NOTES_SMOKE_TRANSCRIPT_TEXT": "Smoke transcript text for audio import.",
                    "TRANSCRIBE_AUDIO": str(audio_path),
                    "TRANSCRIPT_OUT": str(transcript_path),
                },
                clear=False,
            ):
                with mock.patch.object(transcribe_file, "send", side_effect=events.append):
                    with mock.patch.object(transcribe_file, "load_model") as load_model:
                        transcribe_file.main()

            self.assertFalse(load_model.called)
            self.assertEqual(transcript_path.read_text(encoding="utf-8"), "Smoke transcript text for audio import.")
            self.assertEqual([event["event"] for event in events], ["ready", "started", "done"])


if __name__ == "__main__":
    unittest.main()
