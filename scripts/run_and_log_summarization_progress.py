#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import List

DEFAULT_TEST_CMD = "conda run -n meeting-notes-runtime python -m unittest discover -s tests -p 'test_*.py' -v"
DEFAULT_LOG_FILE = "SUMMARIZATION_PROGRESS_LOG.md"
PROGRESS_HEADING = "## Progress Updates"
TREND_HEADING = "### Latest observed output trend"
LAST_UPDATED_PREFIX = "Last updated:"


@dataclass
class CommandResult:
    command: str
    exit_code: int
    summary: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run summarization QA checks and append a structured progress entry to the progress log."
    )
    parser.add_argument(
        "--log-file",
        default=DEFAULT_LOG_FILE,
        help=f"Path to progress log file (default: {DEFAULT_LOG_FILE}).",
    )
    parser.add_argument(
        "--run-tests",
        action="store_true",
        help="Run the default summarization unittest command and include result in the log entry.",
    )
    parser.add_argument(
        "--test-cmd",
        action="append",
        default=[],
        help="Additional command(s) to run and capture under 'Validation run'.",
    )
    parser.add_argument(
        "--change",
        action="append",
        required=True,
        help="Change made. Provide multiple times for multiple changes.",
    )
    parser.add_argument(
        "--why",
        required=True,
        help="Why the change was made.",
    )
    parser.add_argument(
        "--result",
        required=True,
        help="Outcome/result of the change.",
    )
    parser.add_argument(
        "--next",
        dest="next_items",
        action="append",
        default=[],
        help="Next follow-up item. Provide multiple times if needed.",
    )
    parser.add_argument(
        "--validation",
        action="append",
        default=[],
        help="Manual validation note to include in the entry.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the generated entry without writing to the log file.",
    )
    return parser.parse_args()


def workspace_root() -> Path:
    return Path(__file__).resolve().parents[1]


def short_summary_from_output(output: str, exit_code: int) -> str:
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if not lines:
        return f"exit={exit_code}"

    for idx, line in enumerate(lines):
        if line.startswith("Ran ") and " test" in line:
            if idx + 1 < len(lines):
                next_line = lines[idx + 1]
                if next_line in {"OK", "FAILED"} or next_line.startswith("FAILED"):
                    return f"{line}; {next_line}; exit={exit_code}"
            return f"{line}; exit={exit_code}"

    tail = "; ".join(lines[-2:]) if len(lines) >= 2 else lines[-1]
    return f"{tail}; exit={exit_code}"


def run_command(command: str, cwd: Path) -> CommandResult:
    proc = subprocess.run(
        command,
        shell=True,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    summary = short_summary_from_output(proc.stdout or "", proc.returncode)
    return CommandResult(command=command, exit_code=proc.returncode, summary=summary)


def build_entry(
    *,
    changes: List[str],
    why: str,
    result: str,
    next_items: List[str],
    command_results: List[CommandResult],
    manual_validation: List[str],
) -> str:
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    lines: List[str] = [f"### {stamp}"]

    for change in changes:
        lines.append(f"- Change made: {change}")
    lines.append(f"- Why: {why}")

    if command_results or manual_validation:
        if command_results:
            for cmd_result in command_results:
                status = "pass" if cmd_result.exit_code == 0 else "fail"
                lines.append(
                    f"- Validation run: `{cmd_result.command}` ({status}) -> {cmd_result.summary}"
                )
        for note in manual_validation:
            lines.append(f"- Validation run: {note}")
    else:
        lines.append("- Validation run: not provided")

    lines.append(f"- Result: {result}")

    if next_items:
        for item in next_items:
            lines.append(f"- Next follow-up: {item}")
    else:
        lines.append("- Next follow-up: none")

    return "\n".join(lines).rstrip() + "\n"


def insert_entry(log_text: str, entry: str) -> str:
    if PROGRESS_HEADING not in log_text:
        suffix = "" if log_text.endswith("\n") else "\n"
        return f"{log_text}{suffix}\n{PROGRESS_HEADING}\n\n{entry}"

    progress_idx = log_text.index(PROGRESS_HEADING)
    insert_idx = len(log_text)

    trend_idx = log_text.find(TREND_HEADING, progress_idx)
    if trend_idx != -1:
        insert_idx = trend_idx
    else:
        next_major = log_text.find("\n## ", progress_idx + len(PROGRESS_HEADING))
        if next_major != -1:
            insert_idx = next_major + 1

    before = log_text[:insert_idx].rstrip()
    after = log_text[insert_idx:].lstrip("\n")
    return f"{before}\n\n{entry}\n{after}"


def update_last_updated(log_text: str, date_str: str) -> str:
    replacement = f"{LAST_UPDATED_PREFIX} {date_str}"
    if LAST_UPDATED_PREFIX in log_text:
        lines = log_text.splitlines()
        for idx, line in enumerate(lines):
            if line.startswith(LAST_UPDATED_PREFIX):
                lines[idx] = replacement
                return "\n".join(lines).rstrip() + "\n"
        return log_text

    lines = log_text.splitlines()
    if lines and lines[0].startswith("# "):
        lines.insert(1, "")
        lines.insert(2, replacement)
        return "\n".join(lines).rstrip() + "\n"
    return f"{replacement}\n\n{log_text.lstrip()}"


def main() -> int:
    args = parse_args()
    root = workspace_root()
    log_path = (root / args.log_file).resolve()

    commands: List[str] = []
    if args.run_tests:
        commands.append(DEFAULT_TEST_CMD)
    commands.extend(args.test_cmd)

    command_results: List[CommandResult] = []
    for command in commands:
        result = run_command(command, cwd=root)
        command_results.append(result)

    entry = build_entry(
        changes=args.change,
        why=args.why.strip(),
        result=args.result.strip(),
        next_items=args.next_items,
        command_results=command_results,
        manual_validation=args.validation,
    )

    if args.dry_run:
        print(entry, end="")
        return 0

    if log_path.exists():
        current = log_path.read_text(encoding="utf-8")
    else:
        current = "# Summarization Progress Log\n\n"

    updated = insert_entry(current, entry)
    updated = update_last_updated(updated, datetime.now().strftime("%Y-%m-%d"))
    log_path.write_text(updated, encoding="utf-8")

    print(f"Appended progress entry to {log_path}")
    failed = [res for res in command_results if res.exit_code != 0]
    if failed:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
