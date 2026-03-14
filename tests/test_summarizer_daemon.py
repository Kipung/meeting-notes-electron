import threading
import unittest
from unittest import mock

import backend.summarizer_daemon as summarizer_daemon
from backend.summarizer_daemon import (
    CHUNK_SUMMARY_PROMPT,
    DEFAULT_PROMPT,
    FINAL_METADATA_PROMPT_GUIDANCE,
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


class StreamingDeltaClient:
    def __init__(self, parts):
        self.parts = parts

    def create_completion(self, *, prompt: str, max_tokens: int, temperature: float, stream: bool = False):
        if not stream:
            return {"choices": [{"text": "".join(self.parts)}]}
        return iter([{"choices": [{"text": part}]} for part in self.parts])


class SummarizerDaemonTests(unittest.TestCase):
    def test_prompts_forbid_invented_roles_and_generic_admin_tasks(self):
        self.assertIn("You are a meeting notes summarizer.", DEFAULT_PROMPT)
        self.assertIn("Do not invent facts, names, roles, or action items.", DEFAULT_PROMPT)
        self.assertIn("Prefer concrete nouns and entities already named in the meeting content", DEFAULT_PROMPT)
        self.assertIn("Do not turn tentative suggestions, scheduling possibilities, or follow-up checks into confirmed outcomes.", DEFAULT_PROMPT)
        self.assertIn("Action Items:", DEFAULT_PROMPT)
        self.assertIn("use it to frame the opening sentence", FINAL_METADATA_PROMPT_GUIDANCE)
        self.assertIn("Do not include a student ID unless it is necessary for clarity.", FINAL_METADATA_PROMPT_GUIDANCE)
        self.assertIn("You are a meeting notes summarizer.", CHUNK_SUMMARY_PROMPT)
        self.assertIn("Do not invent facts, names, roles, or action items.", CHUNK_SUMMARY_PROMPT)

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

    def test_short_final_transcript_uses_single_full_context_summary(self):
        client = StaticClient(
            "Summary:\n"
            "The advisor and student reviewed a schedule change caused by an unfinished avionics course.\n\n"
            "Action Items:\n"
            "- Student: email JR Riggs to confirm the wait list."
        )
        daemon = SummarizerDaemon.__new__(SummarizerDaemon)
        daemon.model_path = "mock://summary"
        daemon.n_ctx = 2048
        daemon.min_words = 1
        daemon.client = client
        daemon.lock = threading.Lock()
        daemon.send = lambda _obj: None  # type: ignore[assignment]

        transcript = (
            "The student needs to drop meteorology to add modern avionics. "
            "Modern avionics conflicts with chapel, but it can be taken in a different semester. "
            "The advisor asked the student to email JR Riggs to confirm the Flight 117 wait list."
        )
        daemon.summarize(
            transcript,
            out_path=None,
            chunk_words=50,
            context={"type": "final", "sessionDir": "mock/session"},
        )

        self.assertEqual(len(client.calls), 1)
        self.assertIn(DEFAULT_PROMPT.strip(), client.calls[0]["prompt"])
        self.assertNotIn(CHUNK_SUMMARY_PROMPT.strip(), client.calls[0]["prompt"])

    def test_final_summary_uses_session_metadata_as_supporting_context(self):
        client = StaticClient(
            "Summary:\n"
            "The coach and student reviewed attendance and tutoring plans.\n\n"
            "Action Items:\n"
            "- Student: attend tutoring this week."
        )
        daemon = SummarizerDaemon.__new__(SummarizerDaemon)
        daemon.model_path = "mock://summary"
        daemon.n_ctx = 2048
        daemon.min_words = 1
        daemon.client = client
        daemon.lock = threading.Lock()
        daemon.send = lambda _obj: None  # type: ignore[assignment]

        daemon.summarize(
            "Coach: We reviewed attendance and tutoring support for algebra.",
            out_path=None,
            chunk_words=600,
            context={
                "type": "final",
                "sessionDir": "mock/session",
                "subject": "Algebra",
                "student_name": "Ada Lovelace",
                "coach": "KL",
            },
        )

        self.assertTrue(client.calls)
        prompt = client.calls[0]["prompt"]
        self.assertIn(FINAL_METADATA_PROMPT_GUIDANCE.strip(), prompt)
        self.assertIn("Session metadata (supporting context):", prompt)
        self.assertIn("- Subject: Algebra", prompt)
        self.assertIn("- Student Name: Ada Lovelace", prompt)
        self.assertIn("- Coach: KL", prompt)
        self.assertIn("Meeting content:\nCoach: We reviewed attendance and tutoring support for algebra.", prompt)

    def test_final_summary_prompt_omits_student_id_from_supporting_metadata(self):
        client = StaticClient(
            "Summary:\n"
            "The coach and student reviewed attendance and tutoring plans.\n\n"
            "Action Items: none."
        )
        daemon = SummarizerDaemon.__new__(SummarizerDaemon)
        daemon.model_path = "mock://summary"
        daemon.n_ctx = 2048
        daemon.min_words = 1
        daemon.client = client
        daemon.lock = threading.Lock()
        daemon.send = lambda _obj: None  # type: ignore[assignment]

        daemon.summarize(
            "Coach: We reviewed attendance and tutoring support for algebra.",
            out_path=None,
            chunk_words=600,
            context={
                "type": "final",
                "sessionDir": "mock/session",
                "subject": "Algebra",
                "student_name": "Ada Lovelace",
                "student_id": "S123456",
                "coach": "KL",
            },
        )

        self.assertTrue(client.calls)
        prompt = client.calls[0]["prompt"]
        self.assertNotIn("- Student ID: S123456", prompt)
        self.assertIn("- Student Name: Ada Lovelace", prompt)

    def test_short_final_transcript_does_not_use_metadata_to_bypass_min_words(self):
        client = StaticClient("Summary:\nShould not be used.\n\nAction Items: none.")
        daemon = SummarizerDaemon.__new__(SummarizerDaemon)
        daemon.model_path = "mock://summary"
        daemon.n_ctx = 2048
        daemon.min_words = 20
        daemon.client = client
        daemon.lock = threading.Lock()

        events = []
        daemon.send = lambda obj: events.append(obj)  # type: ignore[assignment]
        daemon.summarize(
            "Thanks.",
            out_path=None,
            chunk_words=600,
            context={
                "type": "final",
                "sessionDir": "mock/session",
                "subject": "Algebra",
                "student_name": "Ada Lovelace",
                "coach": "KL",
            },
        )

        self.assertEqual(client.calls, [])
        done = next((event for event in events if event.get("event") == "done"), None)
        self.assertIsNotNone(done)
        self.assertEqual(done.get("text"), "Summary:\nNot enough content to summarize.\n\nAction Items: none.")

    def test_final_summary_injects_subject_metadata_when_model_output_is_generic(self):
        client = StaticClient(
            "Summary:\n"
            "Alex agreed to attend two tutoring sessions and complete the correction packet before the next meeting.\n\n"
            "Action Items: none."
        )
        daemon = SummarizerDaemon.__new__(SummarizerDaemon)
        daemon.model_path = "mock://summary"
        daemon.n_ctx = 2048
        daemon.min_words = 1
        daemon.client = client
        daemon.lock = threading.Lock()

        events = []
        daemon.send = lambda obj: events.append(obj)  # type: ignore[assignment]
        daemon.summarize(
            (
                "Coach: We reviewed the missed quizzes, unfinished labs, and tutoring options for chemistry. "
                "Student: I agreed to attend two tutoring sessions this week, finish the correction packet, "
                "and send an update before the next check-in."
            ),
            out_path=None,
            chunk_words=600,
            context={
                "type": "final",
                "sessionDir": "mock/session",
                "modality": "Virtual Appointment",
                "subject": "CHEM 120 recovery plan",
                "student_name": "Alex Rivera",
                "student_id": "S123456",
            },
        )

        done = next((event for event in events if event.get("event") == "done"), None)
        self.assertIsNotNone(done)
        summary_text = done.get("text", "")
        self.assertIn("CHEM 120 recovery plan", summary_text)
        self.assertIn("Virtual Appointment", summary_text)
        self.assertNotIn("S123456", summary_text)

    def test_final_summary_metadata_prefix_keeps_generic_meeting_lead_readable(self):
        client = StaticClient(
            "Summary:\n"
            "The meeting focused on missing appeal documents and submission timing.\n\n"
            "Action Items: none."
        )
        daemon = SummarizerDaemon.__new__(SummarizerDaemon)
        daemon.model_path = "mock://summary"
        daemon.n_ctx = 2048
        daemon.min_words = 1
        daemon.client = client
        daemon.lock = threading.Lock()

        events = []
        daemon.send = lambda obj: events.append(obj)  # type: ignore[assignment]
        daemon.summarize(
            "Coach: We reviewed the missing appeal documents and the next deadline.",
            out_path=None,
            chunk_words=600,
            context={
                "type": "final",
                "sessionDir": "mock/session",
                "modality": "Phone Appointment",
                "subject": "SAP appeal follow-up",
            },
        )

        done = next((event for event in events if event.get("event") == "done"), None)
        self.assertIsNotNone(done)
        summary_text = done.get("text", "")
        self.assertIn(
            "During the Phone Appointment about SAP appeal follow-up, the meeting focused",
            summary_text,
        )

    def test_chunk_summary_does_not_embed_session_metadata(self):
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
            context={
                "type": "chunk",
                "id": 2,
                "sessionDir": "mock/session",
                "subject": "Physics",
                "student_name": "Ada Lovelace",
            },
        )

        self.assertTrue(client.calls)
        prompt = client.calls[0]["prompt"]
        self.assertNotIn(FINAL_METADATA_PROMPT_GUIDANCE.strip(), prompt)
        self.assertNotIn("Session metadata (supporting context):", prompt)
        self.assertNotIn("Ada Lovelace", prompt)

    def test_streaming_delta_chunks_do_not_drop_repeated_tokens(self):
        client = StreamingDeltaClient(["the student reviewed ", "the ", "schedule and ", "the timeline."])
        streamed = []
        result = summarize_with_llm(
            client,
            "transcript text",
            DEFAULT_PROMPT,
            max_tokens=128,
            on_delta=lambda d: streamed.append(d),
        )
        self.assertEqual(result, "the student reviewed the schedule and the timeline.")
        self.assertEqual("".join(streamed), "the student reviewed the schedule and the timeline.")

    def test_create_llama_defers_import_failure_until_model_load(self):
        with mock.patch.object(summarizer_daemon, "Llama", None), mock.patch.object(
            summarizer_daemon, "LLAMA_IMPORT_ERROR", "No module named 'llama_cpp'"
        ):
            with self.assertRaisesRegex(RuntimeError, "No module named 'llama_cpp'"):
                summarizer_daemon.create_llama("mock://model.gguf", 2048)

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
