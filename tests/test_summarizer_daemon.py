import threading
import unittest

from backend.summarizer_daemon import (
    CHUNK_SUMMARY_PROMPT,
    DEFAULT_PROMPT,
    SummarizerDaemon,
    compress_chunk_summaries_for_final,
    count_words,
    summarize_with_llm,
)


class OverflowRetryClient:
    def __init__(self):
        self.calls = []

    def create_completion(self, *, prompt: str, max_tokens: int, temperature: float, stream: bool = False):
        self.calls.append(max_tokens)
        if max_tokens > 300:
            raise Exception("Requested tokens (2147) exceed context window of 2048")
        return {"choices": [{"text": "Short grounded summary."}]}


class StaticClient:
    def __init__(self, response: str):
        self.response = response
        self.calls = []

    def create_completion(self, *, prompt: str, max_tokens: int, temperature: float, stream: bool = False):
        self.calls.append({"prompt": prompt, "max_tokens": max_tokens, "stream": stream})
        if stream:
            return iter([{"choices": [{"text": self.response}]}])
        return {"choices": [{"text": self.response}]}


class SummarizerDaemonTests(unittest.TestCase):
    def test_summarize_with_llm_retries_with_smaller_max_tokens_on_context_overflow(self):
        client = OverflowRetryClient()
        result = summarize_with_llm(client, "This is a test transcript.", DEFAULT_PROMPT, max_tokens=1024)
        self.assertEqual(result, "Short grounded summary.")
        self.assertGreaterEqual(len(client.calls), 2)
        self.assertLessEqual(client.calls[-1], 300)

    def test_chunk_context_returns_compact_summary_without_action_section(self):
        raw_chunk_response = (
            "Summary:\n"
            "The student discussed attendance concerns.\n\n"
            "Action Items:\n"
            "- Student should attend tutoring.\n"
            "- Coach should follow up."
        )
        client = StaticClient(raw_chunk_response)
        daemon = SummarizerDaemon.__new__(SummarizerDaemon)
        daemon.model_path = "mock://summary"
        daemon.n_ctx = 2048
        daemon.min_words = 1
        daemon.client = client
        daemon.lock = threading.Lock()

        events = []
        daemon.send = lambda obj: events.append(obj)  # type: ignore[assignment]
        daemon.summarize(
            "Coach: We reviewed attendance and discussed tutoring support.",
            out_path=None,
            chunk_words=600,
            context={"type": "chunk", "id": 1, "sessionDir": "mock/session"},
        )

        done = next((event for event in events if event.get("event") == "done"), None)
        self.assertIsNotNone(done)
        summary_text = done.get("text", "")
        self.assertTrue(summary_text)
        self.assertNotIn("Action Items:", summary_text)
        self.assertIn("attendance", summary_text.lower())
        self.assertTrue(any(call["max_tokens"] == 256 for call in client.calls))

    def test_chunk_context_uses_chunk_prompt(self):
        client = StaticClient("The session focused on assignment planning.")
        daemon = SummarizerDaemon.__new__(SummarizerDaemon)
        daemon.model_path = "mock://summary"
        daemon.n_ctx = 2048
        daemon.min_words = 1
        daemon.client = client
        daemon.lock = threading.Lock()
        daemon.send = lambda _obj: None  # type: ignore[assignment]

        daemon.summarize(
            "Student: I will submit the assignment by Friday.",
            out_path=None,
            chunk_words=600,
            context={"type": "chunk", "id": 2, "sessionDir": "mock/session"},
        )

        self.assertTrue(client.calls)
        self.assertIn(CHUNK_SUMMARY_PROMPT.strip(), client.calls[0]["prompt"])

    def test_compress_chunk_summaries_respects_budget_and_keeps_high_importance(self):
        chunk_summaries = [
            "The coach reviewed attendance and current assignments for the week.",
            "The student shared wins from tutoring and office hours engagement.",
            "A critical risk was flagged because financial aid eligibility may be lost after another missed deadline.",
            "The coach and student aligned on routine check-ins and support cadence.",
            "The student discussed exam preparation and confidence building steps.",
            "The meeting ended with encouragement and a reminder to keep momentum.",
        ]
        compressed = compress_chunk_summaries_for_final(
            chunk_summaries,
            max_total_words=36,
            per_chunk_max_words=12,
        )
        joined = " ".join(compressed).lower()
        self.assertLessEqual(count_words(" ".join(compressed)), 36)
        self.assertIn("critical risk", joined)

    def test_compress_chunk_summaries_trims_single_over_budget_item(self):
        chunk_summaries = [
            " ".join(["update"] * 80),
        ]
        compressed = compress_chunk_summaries_for_final(
            chunk_summaries,
            max_total_words=20,
            per_chunk_max_words=80,
        )
        self.assertEqual(len(compressed), 1)
        self.assertLessEqual(count_words(compressed[0]), 20)


if __name__ == "__main__":
    unittest.main()
