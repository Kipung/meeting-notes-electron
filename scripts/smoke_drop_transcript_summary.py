#!/usr/bin/env python3
from __future__ import annotations

import argparse
import threading
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from backend.summarizer_daemon import SummarizerDaemon


FIXTURE_CASES: Dict[str, Dict[str, str]] = {
    "student_success_risk_case": {
        "transcript": "tests/fixtures/transcripts/student_success_risk_case.txt",
        "raw": (
            "Summary:\n"
            "Coach and student reviewed current progress in algebra.\n\n"
            "Action Items: none."
        ),
    },
    "student_success_no_action_case": {
        "transcript": "tests/fixtures/transcripts/student_success_no_action_case.txt",
        "raw": (
            "Summary:\n"
            "This was an introductory coaching conversation focused on context and goals.\n\n"
            "Action Items: none."
        ),
    },
    "student_success_messy_output_case": {
        "transcript": "tests/fixtures/transcripts/student_success_messy_output_case.txt",
        "raw": (
            "Team aligned on attendance recovery and course planning\n"
            "High Importance:\n"
            "- serious risk of failing course with additional absences\n"
            "Action Items:\n"
            "student email professor tonight; coach follow up monday and coordinate tutoring if needed"
        ),
    },
}


class FakeClient:
    def __init__(self, responses: List[str]):
        self._responses = responses
        self._idx = 0

    def _next(self) -> str:
        if not self._responses:
            return ""
        text = self._responses[min(self._idx, len(self._responses) - 1)]
        self._idx += 1
        return text

    def create_completion(self, *, stream: bool = False, **_: object):
        text = self._next()
        if not stream:
            return {"choices": [{"text": text}]}
        midpoint = max(1, len(text) // 2)
        return iter(
            [
                {"choices": [{"text": text[:midpoint]}]},
                {"choices": [{"text": text}]},
            ]
        )

    def create(self, **kwargs: object):
        return self.create_completion(**kwargs)

    def __call__(self, *_args: object, **kwargs: object):
        return self.create_completion(**kwargs)


def run_case(
    name: str,
    transcript_path: Path,
    raw_response: str,
    daemon: Optional[SummarizerDaemon] = None,
    model_path: Optional[str] = None,
    n_ctx: int = 2048,
) -> Tuple[str, List[dict]]:
    transcript = transcript_path.read_text(encoding="utf-8")
    events: List[dict] = []
    active_daemon = daemon
    if active_daemon is None:
        if model_path:
            active_daemon = SummarizerDaemon(model_path=model_path, n_ctx=n_ctx, min_words=20)
        else:
            active_daemon = SummarizerDaemon.__new__(SummarizerDaemon)
            active_daemon.model_path = "mock://summary"
            active_daemon.n_ctx = n_ctx
            active_daemon.min_words = 20
            active_daemon.client = FakeClient([raw_response])
            active_daemon.lock = threading.Lock()
    active_daemon.send = lambda obj: events.append(obj)  # type: ignore[assignment]
    active_daemon.summarize(
        transcript,
        out_path=None,
        chunk_words=800,
        context={"type": "final", "sessionDir": f"mock/{name}"},
    )
    done = next((event for event in events if event.get("event") == "done"), None)
    if not done:
        raise RuntimeError(f"{name}: did not receive done event")
    return str(done.get("text", "")), events


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke-test dropped transcript summary output formatting.")
    parser.add_argument(
        "--case",
        choices=sorted(FIXTURE_CASES.keys()),
        help="Run a single case. Defaults to all cases.",
    )
    parser.add_argument(
        "--model-path",
        help="Use a real GGUF model path instead of mock LLM responses.",
    )
    parser.add_argument(
        "--n-ctx",
        type=int,
        default=2048,
        help="Context window when using --model-path.",
    )
    args = parser.parse_args()

    selected_names = [args.case] if args.case else sorted(FIXTURE_CASES.keys())
    daemon: Optional[SummarizerDaemon] = None
    if args.model_path:
        daemon = SummarizerDaemon(model_path=args.model_path, n_ctx=max(args.n_ctx, 256), min_words=20)
    for name in selected_names:
        case = FIXTURE_CASES[name]
        transcript_path = Path(case["transcript"])
        if not transcript_path.exists():
            raise FileNotFoundError(f"{name}: transcript fixture missing: {transcript_path}")
        summary_text, events = run_case(
            name,
            transcript_path,
            case["raw"],
            daemon=daemon,
            model_path=args.model_path,
            n_ctx=max(args.n_ctx, 256),
        )
        print(f"\n=== {name} ===")
        print(f"transcript: {transcript_path}")
        if args.model_path:
            print(f"model: {args.model_path}")
        else:
            print("model: mock")
        print(f"events: {len(events)} (done={any(e.get('event') == 'done' for e in events)})")
        print("\nsummary box output:\n")
        print(summary_text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
