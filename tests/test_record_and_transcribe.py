import os
import unittest
from unittest import mock

from backend import recording_vad_utils


class RecordAndTranscribeHelperTests(unittest.TestCase):
    def test_positive_int_from_env_uses_default_for_missing_or_invalid_values(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            self.assertEqual(recording_vad_utils.positive_int_from_env(os.environ.get("VAD_MAX_UTTERANCE_MS"), 8000), 8000)
        with mock.patch.dict(os.environ, {"VAD_MAX_UTTERANCE_MS": "abc"}, clear=False):
            self.assertEqual(recording_vad_utils.positive_int_from_env(os.environ.get("VAD_MAX_UTTERANCE_MS"), 8000), 8000)
        with mock.patch.dict(os.environ, {"VAD_MAX_UTTERANCE_MS": "0"}, clear=False):
            self.assertEqual(recording_vad_utils.positive_int_from_env(os.environ.get("VAD_MAX_UTTERANCE_MS"), 8000), 8000)
        with mock.patch.dict(os.environ, {"VAD_MAX_UTTERANCE_MS": "4500"}, clear=False):
            self.assertEqual(recording_vad_utils.positive_int_from_env(os.environ.get("VAD_MAX_UTTERANCE_MS"), 8000), 4500)

    def test_frames_for_ms_rounds_up_and_respects_zero_duration(self):
        self.assertEqual(recording_vad_utils.frames_for_ms(0, 32.0), 0)
        self.assertEqual(recording_vad_utils.frames_for_ms(200, 32.0), 7)
        self.assertEqual(recording_vad_utils.frames_for_ms(600, 32.0), 19)

    def test_take_post_pad_frames_limits_trailing_silence(self):
        frames = [("frame", idx) for idx in range(5)]
        clipped = recording_vad_utils.take_post_pad_frames(frames, 2)
        self.assertEqual(len(clipped), 2)
        self.assertEqual(clipped[0], ("frame", 0))
        self.assertEqual(clipped[1], ("frame", 1))

    def test_force_flush_triggers_when_utterance_budget_is_reached(self):
        frames = [
            tuple(range(1600)),
            tuple(range(1600)),
            tuple(range(1600)),
        ]
        self.assertFalse(recording_vad_utils.should_force_flush_utterance(frames[:1], 4000))
        self.assertTrue(recording_vad_utils.should_force_flush_utterance(frames, 4000))


if __name__ == "__main__":
    unittest.main()
