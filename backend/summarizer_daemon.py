from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
from typing import Callable, List, Optional

try:
    from .summary_formatting import finalize_action_items_output, split_sentences
except ImportError:
    from summary_formatting import finalize_action_items_output, split_sentences

try:
    from llama_cpp import Llama
except Exception as e:
    print(json.dumps({"event": "error", "msg": f"failed to import llama_cpp: {e}"}))
    # Do not exit; allow the daemon to run without Llama for testing purposes
    # sys.exit(1)



def count_words(text: str) -> int:
    return len(text.split())


def min_words_from_env(default: int) -> int:
    raw = os.getenv("SUM_MIN_WORDS", "").strip()
    if raw.isdigit():
        return max(int(raw), 1)
    return default


def clamp_temperature(value: float) -> float:
    if value < 0:
        return 0.0
    if value > 1:
        return 1.0
    return value


def temperature_from_env(default: float) -> float:
    raw = os.getenv("FOLLOWUP_TEMP", "").strip()
    try:
        return clamp_temperature(float(raw))
    except Exception:
        return default


def max_tokens_from_env(default: int) -> int:
    raw = os.getenv("FOLLOWUP_MAX_TOKENS", "").strip()
    if raw.isdigit():
        return max(int(raw), 1)
    return default


DEFAULT_PROMPT = (
    "You are an assistant that summarizes meeting transcripts.\n"
    "Return only these sections in this exact order with the same headings:\n"
    "Summary:\n"
    "Action Items:\n"
    "In 'Summary', write 3-4 concise sentences (max 140 words), grounded only in the transcript.\n"
    "Make sure the summary explicitly includes any high-importance decisions, risks, blockers, or deadlines when they appear.\n"
    "For student success coaching sessions, highlight the student's current goal/progress, primary barriers, and agreed support plan when present.\n"
    "Stay focused on the meeting content and do not add unrelated information.\n"
    "Use normal sentence capitalization and spacing (for example, 'Speaker 2', not 'speaker2' or 'and1').\n"
    "If metadata such as Modality, Subject, Student ID, Student Name, or Coach is provided at the top of the input, include relevant details briefly in the summary.\n"
    "In 'Action Items', include up to five bullets only for explicit follow-up tasks supported by the transcript.\n"
    "Prioritize concrete student-success follow-ups (assignments, outreach, tutoring, scheduling, resource referrals).\n"
    "Each action bullet should include owner/topic and due date or timing when available.\n"
    "Do not output placeholder template text such as 'Owner', 'Topic', or 'Due Date'.\n"
    "If no actionable follow-up is clearly supported, write 'Action Items: none.'\n"
    "Do not invent details and do not add extra sections.\n"
)
DEFAULT_CHUNK_WORDS = int(os.getenv("SUM_CHUNK_WORDS", "200"))
CHUNK_SUMMARY_PROMPT = (
    "You are an assistant that summarizes meeting transcripts.\n"
    "Produce a concise 2-3 sentence summary focused only on the provided text.\n"
    "Ground every sentence in the transcript and keep the paragraph tidy and self-contained.\n"
    "Do not include an 'Action Items:' section in this response; only provide the summary paragraph.\n"
)
SHORT_TRANSCRIPT_SUMMARY = (
    "Summary:\n"
    "Not enough content to summarize.\n\n"
    "Action Items: none."
)
CONTEXT_OVERFLOW_PATTERNS = (
    "exceed context window",
    "requested tokens",
    "context window",
)
FINAL_AGGREGATE_MAX_WORDS = int(os.getenv("SUM_FINAL_AGG_MAX_WORDS", "900"))
FINAL_AGGREGATE_PER_CHUNK_MAX_WORDS = int(os.getenv("SUM_FINAL_CHUNK_MAX_WORDS", "60"))
FINAL_IMPORTANCE_HINTS = (
    "critical",
    "urgent",
    "risk",
    "blocker",
    "blocked",
    "deadline",
    "due",
    "escalat",
    "at risk",
    "probation",
    "ineligible",
    "failing",
    "fail",
    "compliance",
    "incident",
)

def split_into_chunks(text: str, max_words: int) -> List[str]:
    """Split *text* into a list of strings each containing up to *max_words* words.
    Simple whitespace tokenisation is sufficient for our use‑case.
    """
    words = text.split()
    chunks: List[str] = []
    for i in range(0, len(words), max_words):
        chunk_words = words[i : i + max_words]
        chunks.append(" ".join(chunk_words))
    return chunks

FOLLOWUP_PROMPT = (
    "You are an assistant that drafts a warm, professional follow-up email after a student support session.\n"
    "Use the summary below as the only source of truth.\n"
    "Write in a warm, supportive tone.\n"
    "If a student name is provided, use it exactly once in the greeting and do not invent any other names.\n"
    "If no student name is supplied, do not introduce or refer to any proper names; stay name-agnostic and use a generic greeting (e.g., 'Hello').\n"
    "Include a Subject line, then a blank line, then the email body.\n"
    "If the summary includes action items, include them under an 'Action items:' section.\n"
    "Do not add extra notes, disclaimers, or meta commentary.\n"
    "Keep it concise and clear.\n"
)

FOLLOWUP_NOTES_RE = re.compile(r"\n\s*(notes?|additional notes?)\s*:\s*.*$", re.IGNORECASE | re.DOTALL)


def clean_followup_email(text: str) -> str:
    cleaned = text.strip()
    cleaned = FOLLOWUP_NOTES_RE.sub("", cleaned).strip()
    return cleaned


def is_context_overflow_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return any(pattern in msg for pattern in CONTEXT_OVERFLOW_PATTERNS)


def normalize_chunk_summary(text: str, max_sentences: int = 3, max_words: int = 90) -> str:
    raw = (text or "").strip()
    if not raw:
        return ""
    lowered = raw.lower()
    if lowered.startswith("summary:"):
        raw = raw[len("summary:") :].strip()
    for marker in ("Action Items:", "High Importance:"):
        idx = raw.find(marker)
        if idx != -1:
            raw = raw[:idx].strip()
    sentences = [s.strip() for s in split_sentences(raw) if s.strip()]
    if not sentences:
        return ""
    trimmed = sentences[:max_sentences]
    normalized: List[str] = []
    for sentence in trimmed:
        if sentence[-1] not in ".!?":
            sentence = f"{sentence}."
        normalized.append(sentence)
    summary = " ".join(normalized).strip()
    words = summary.split()
    if len(words) > max_words:
        summary = " ".join(words[:max_words]).rstrip(" ,;:") + "..."
    return summary


def trim_words(text: str, max_words: int) -> str:
    words = text.split()
    if len(words) <= max_words:
        return text.strip()
    return " ".join(words[:max_words]).rstrip(" ,;:") + "..."


def contains_high_importance_signal(text: str) -> bool:
    lowered = text.lower()
    return any(token in lowered for token in FINAL_IMPORTANCE_HINTS)


def compress_chunk_summaries_for_final(
    chunk_summaries: List[str],
    max_total_words: int = FINAL_AGGREGATE_MAX_WORDS,
    per_chunk_max_words: int = FINAL_AGGREGATE_PER_CHUNK_MAX_WORDS,
) -> List[str]:
    if not chunk_summaries:
        return []
    normalized: List[str] = []
    for raw in chunk_summaries:
        compact = normalize_chunk_summary(raw, max_sentences=2, max_words=per_chunk_max_words)
        if compact:
            normalized.append(compact)
    if not normalized:
        return []
    if max_total_words <= 0:
        return normalized
    if sum(count_words(item) for item in normalized) <= max_total_words:
        return normalized

    selected_indexes: List[int] = []
    seen = set()
    words_used = 0

    def try_add(idx: int):
        nonlocal words_used
        if idx < 0 or idx >= len(normalized) or idx in seen:
            return
        candidate = normalized[idx]
        candidate_words = count_words(candidate)
        if candidate_words <= 0:
            return
        if not selected_indexes:
            if candidate_words > max_total_words:
                candidate = trim_words(candidate, max_total_words)
                candidate_words = count_words(candidate)
                normalized[idx] = candidate
            selected_indexes.append(idx)
            seen.add(idx)
            words_used += candidate_words
            return
        if words_used + candidate_words > max_total_words:
            return
        selected_indexes.append(idx)
        seen.add(idx)
        words_used += candidate_words

    for idx, summary in enumerate(normalized):
        if contains_high_importance_signal(summary):
            try_add(idx)
    try_add(0)
    try_add(len(normalized) - 1)
    for idx in range(len(normalized)):
        try_add(idx)

    if not selected_indexes:
        return [trim_words(normalized[0], max_total_words)]
    selected_indexes.sort()
    return [normalized[idx] for idx in selected_indexes]


def summarize_with_llm(
    client: Llama,
    text: str,
    prompt: str,
    max_tokens: int = 1024,
    on_delta: Optional[Callable[[str], None]] = None,
) -> str:
    full_prompt = prompt + "\n\nTranscript:\n" + text + "\n\nSummary:\n"

    def run_completion(current_max_tokens: int, stream: bool):
        if hasattr(client, "create_completion"):
            return client.create_completion(
                prompt=full_prompt,
                max_tokens=current_max_tokens,
                temperature=0.2,
                stream=stream,
            )
        if hasattr(client, "create"):
            return client.create(
                prompt=full_prompt,
                max_tokens=current_max_tokens,
                temperature=0.2,
                stream=stream,
            )
        return client(
            full_prompt,
            max_tokens=current_max_tokens,
            temperature=0.2,
            stream=stream,
        )

    current_max_tokens = max_tokens
    if on_delta:
        for _ in range(3):
            try:
                resp = run_completion(current_max_tokens, stream=True)
                collected = ""
                for chunk in resp:
                    chunk_text = chunk.get("choices", [{}])[0].get("text", "")
                    if not chunk_text:
                        continue
                    if not collected:
                        collected = chunk_text
                        on_delta(chunk_text)
                        continue
                    if chunk_text.startswith(collected):
                        delta = chunk_text[len(collected) :]
                        collected = chunk_text
                    elif chunk_text in collected:
                        delta = ""
                    else:
                        max_overlap = 0
                        max_len = min(len(collected), len(chunk_text))
                        for i in range(1, max_len + 1):
                            if collected[-i:] == chunk_text[:i]:
                                max_overlap = i
                        delta = chunk_text[max_overlap:]
                        if delta:
                            collected += delta
                    if delta:
                        on_delta(delta)
                return collected.strip()
            except Exception as e:
                if not is_context_overflow_error(e) or current_max_tokens <= 128:
                    break
                current_max_tokens = max(128, current_max_tokens // 2)
    for _ in range(3):
        try:
            resp = run_completion(current_max_tokens, stream=False)
            return resp.get("choices", [{}])[0].get("text", "").strip()
        except Exception as e:
            if not is_context_overflow_error(e) or current_max_tokens <= 128:
                raise
            current_max_tokens = max(128, current_max_tokens // 2)
    return ""


def generate_followup_email(
    client: Llama,
    summary: str,
    instructions: str,
    max_tokens: int,
    temperature: float,
    student_name: str,
) -> str:
    prompt = FOLLOWUP_PROMPT
    if student_name:
        prompt += f"\nStudent name: {student_name}\n"
    if instructions:
        prompt += "\nAdditional instructions:\n" + instructions.strip() + "\n"
    full_prompt = prompt + "\nSummary:\n" + summary + "\n\nEmail:\n"
    if hasattr(client, "create_completion"):
        resp = client.create_completion(prompt=full_prompt, max_tokens=max_tokens, temperature=temperature)
    elif hasattr(client, "create"):
        resp = client.create(prompt=full_prompt, max_tokens=max_tokens, temperature=temperature)
    else:
        resp = client(full_prompt, max_tokens=max_tokens, temperature=temperature)
    email = resp.get("choices", [{}])[0].get("text", "")
    return clean_followup_email(email)


def summarize_direct(
    client: Llama,
    text: str,
    on_progress: Optional[Callable[[str], None]] = None,
    on_stream: Optional[Callable[[str], None]] = None,
) -> str:
    if on_progress:
        on_progress("summarizing transcript")
    return summarize_with_llm(client, text, DEFAULT_PROMPT, max_tokens=640, on_delta=on_stream)


def create_llama(model_path: str, n_ctx: int) -> Llama:
    try:
        return Llama(model_path=model_path, n_ctx=n_ctx)
    except TypeError:
        return Llama(model_path=model_path)


class SummarizerDaemon:
    def __init__(self, model_path: str, n_ctx: int, min_words: int):
        self.model_path = model_path
        self.n_ctx = n_ctx
        self.min_words = min_words
        self.client = None
        self.lock = threading.Lock()
        self.load_model(model_path)

    def send(self, obj):
        print(json.dumps(obj), flush=True)

    def load_model(self, model_path: str):
        with self.lock:
            try:
                self.send({"event": "progress", "msg": f"loading model {model_path} (n_ctx={self.n_ctx})"})
                self.client = create_llama(model_path, self.n_ctx)
                self.model_path = model_path
                self.send({"event": "loaded", "model": model_path})
            except Exception as e:
                self.send({"event": "error", "msg": f"failed to load model: {e}"})

    def summarize(self, text: str, out_path: Optional[str], chunk_words: int, context: Optional[dict] = None):
        with self.lock:
            if not self.client:
                self.send({"event": "error", "msg": "model not loaded", "out": out_path})
                return
            self.send({"event": "summary_start", "out": out_path, "context": context})
            # Prepend metadata if provided in context or environment variables
            meta_prefix = ""
            meta_lines = []
            # First, from the context dict (if any)
            if context:
                for key in ["modality", "subject", "student_id", "student_name", "coach"]:
                    if key in context and context[key]:
                        meta_lines.append(f"{key.replace('_', ' ').title()}: {context[key]}")
            # Then, fall back to environment variables (e.g., MODALITY, SUBJECT, etc.)
            env_map = {
                "modality": os.getenv("MODALITY"),
                "subject": os.getenv("SUBJECT"),
                "student_id": os.getenv("STUDENT_ID"),
                "student_name": os.getenv("STUDENT_NAME"),
                "coach": os.getenv("COACH"),
            }
            for key, val in env_map.items():
                if val:
                    line = f"{key.replace('_', ' ').title()}: {val}"
                    if line not in meta_lines:
                        meta_lines.append(line)
            if meta_lines:
                meta_prefix = "\n".join(meta_lines) + "\n\n"
            combined_text = meta_prefix + text
            word_count = count_words(combined_text)

            if word_count < self.min_words:
                msg = f"transcript too short ({word_count} words); skipping summary"
                self.send({"event": "progress", "msg": msg, "context": context})
                summary = SHORT_TRANSCRIPT_SUMMARY
                if out_path:
                    try:
                        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
                        with open(out_path, "w", encoding="utf-8") as f:
                            f.write(summary)
                    except Exception as e:
                        self.send({"event": "error", "msg": f"failed to write summary: {e}", "out": out_path, "context": context})
                        return
                self.send({"event": "done", "out": out_path, "text": summary, "secs": 0, "context": context})
                return
            start = time.time()
            chunk_threshold = chunk_words if isinstance(chunk_words, int) and chunk_words > 0 else DEFAULT_CHUNK_WORDS
            context_type = context.get("type") if context else None
            is_chunk_request = context_type == "chunk"
            if is_chunk_request:
                try:
                    chunk_summary = summarize_with_llm(
                        self.client,
                        combined_text,
                        CHUNK_SUMMARY_PROMPT,
                        max_tokens=256,
                    )
                except Exception as e:
                    self.send({"event": "error", "msg": f"summarization error: {e}", "out": out_path, "context": context})
                    return
                summary = normalize_chunk_summary(chunk_summary)
                if not summary:
                    summary = "Not enough content to summarize."
                dur = time.time() - start
                if out_path:
                    try:
                        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
                        with open(out_path, "w", encoding="utf-8") as f:
                            f.write(summary)
                    except Exception as e:
                        self.send({"event": "error", "msg": f"failed to write summary: {e}", "out": out_path, "context": context})
                        return
                self.send({"event": "done", "out": out_path, "text": summary, "secs": dur, "context": context})
                return
            final_input_text = combined_text
            chunks = [chunk.strip() for chunk in split_into_chunks(text, chunk_threshold) if chunk.strip()]
            if len(chunks) > 1:
                chunk_summaries = []
                for idx, chunk_text in enumerate(chunks, start=1):
                    self.send({"event": "progress", "msg": f"summarizing chunk {idx}/{len(chunks)}", "context": context})
                    try:
                        chunk_summary = summarize_with_llm(
                            self.client,
                            chunk_text,
                            CHUNK_SUMMARY_PROMPT,
                            max_tokens=256,
                        )
                    except Exception as e:
                        self.send({"event": "progress", "msg": f"chunk {idx} summary failed: {e}", "context": context})
                        continue
                    compact = normalize_chunk_summary(chunk_summary)
                    if compact:
                        chunk_summaries.append(compact)
                if chunk_summaries:
                    reduced_chunk_summaries = compress_chunk_summaries_for_final(chunk_summaries)
                    if len(reduced_chunk_summaries) < len(chunk_summaries):
                        self.send(
                            {
                                "event": "progress",
                                "msg": (
                                    "compressing aggregated chunk summaries "
                                    f"({len(chunk_summaries)} -> {len(reduced_chunk_summaries)})"
                                ),
                                "context": context,
                            }
                        )
                    aggregated = "\n\n".join(
                        f"Chunk {i + 1} summary:\n{chunk_summary}"
                        for i, chunk_summary in enumerate(reduced_chunk_summaries)
                    )
                    final_input_text = meta_prefix + aggregated
            try:
                summary = summarize_direct(
                    self.client,
                    final_input_text,
                    on_progress=lambda msg: self.send({"event": "progress", "msg": msg, "context": context}),
                    on_stream=lambda delta: self.send({"event": "summary_delta", "text": delta, "out": out_path, "context": context}),
                )
            except Exception as e:
                self.send({"event": "error", "msg": f"summarization error: {e}", "out": out_path, "context": context})
                return
            summary = finalize_action_items_output(summary, text)
            dur = time.time() - start
            if out_path:
                try:
                    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
                    with open(out_path, "w", encoding="utf-8") as f:
                        f.write(summary)
                except Exception as e:
                    self.send({"event": "error", "msg": f"failed to write summary: {e}", "out": out_path, "context": context})
                    return
            self.send({"event": "done", "out": out_path, "text": summary, "secs": dur, "context": context})

    def followup_email(
        self,
        summary: str,
        instructions: str,
        max_tokens: int,
        temperature: float,
        student_name: str,
        request_id: Optional[str],
    ):
        with self.lock:
            if not self.client:
                self.send({"event": "followup_error", "msg": "model not loaded", "id": request_id})
                return
            start = time.time()
            try:
                email = generate_followup_email(
                    self.client,
                    summary,
                    instructions,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    student_name=student_name,
                )
            except Exception as e:
                self.send({"event": "followup_error", "msg": f"follow-up error: {e}", "id": request_id})
                return
            dur = time.time() - start
            self.send({"event": "followup_done", "text": email, "secs": dur, "id": request_id})


def repl_loop(daemon: SummarizerDaemon):
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
        if cmd == "summarize":
            text = None
            if "file" in obj:
                path = obj.get("file")
                if not path or not os.path.exists(path):
                    daemon.send({"event": "error", "msg": f"transcript not found: {path}", "out": obj.get("out")})
                    continue
                with open(path, "r", encoding="utf-8") as f:
                    text = f.read()
            elif "text" in obj:
                text = obj.get("text")
            else:
                daemon.send({"event": "error", "msg": "missing file/text in summarize command"})
                continue
            raw_chunk_words = obj.get("chunk_words", 800)
            try:
                chunk_words = int(raw_chunk_words)
            except Exception:
                chunk_words = 800
            daemon.summarize(text or "", obj.get("out"), chunk_words, obj.get("context"))
        elif cmd == "followup_email":
            summary = obj.get("summary") or obj.get("text")
            if not summary or not isinstance(summary, str):
                daemon.send({"event": "followup_error", "msg": "missing summary in followup_email command", "id": obj.get("id")})
                continue
            instructions = obj.get("instructions") or ""
            if not isinstance(instructions, str):
                instructions = str(instructions)
            student_name = obj.get("student_name") or ""
            if not isinstance(student_name, str):
                student_name = str(student_name)
            temp_raw = obj.get("temperature")
            try:
                temperature = clamp_temperature(float(temp_raw))
            except Exception:
                temperature = temperature_from_env(0.7)
            max_tokens = max_tokens_from_env(320)
            raw_max_tokens = obj.get("max_tokens")
            if raw_max_tokens is not None:
                try:
                    max_tokens = max(int(raw_max_tokens), 1)
                except Exception:
                    pass
            daemon.followup_email(summary, instructions, max_tokens, temperature, student_name, obj.get("id"))
        elif cmd == "load_model":
            model_path = obj.get("model_path")
            if model_path:
                daemon.load_model(model_path)
            else:
                daemon.send({"event": "error", "msg": "missing model_path in load_model command"})
        else:
            daemon.send({"event": "error", "msg": f"unknown cmd: {cmd}", "raw": obj})


def main():
    model_path = (os.getenv("SUMMODEL_PATH") or os.getenv("SUMMODEL") or "").strip()
    if not model_path:
        # Fall back to a model bundled with the repo (if it exists)
        # Look for any .gguf file in the `models/` directory (the correct location in this repo)
        models_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "../models"))
        fallback = None
        if os.path.isdir(models_dir):
            for entry in os.listdir(models_dir):
                if entry.lower().endswith('.gguf'):
                    fallback = os.path.join(models_dir, entry)
                    break
        if fallback and os.path.isfile(fallback):
            model_path = fallback
        # else keep empty – the existing error handling will inform the user

    if not model_path:
        print(
            json.dumps(
                {"event": "error", "msg": "model path not configured; set SUMMODEL_PATH or SUMMODEL"}
            )
        )
        return 2

    if not os.path.exists(model_path):
        print(json.dumps({"event": "error", "msg": f"model not found: {model_path}"}))
        return 2

    env_n_ctx = os.getenv("SUM_N_CTX", "").strip()
    default_n_ctx = 2048
    if env_n_ctx.isdigit():
        n_ctx = int(env_n_ctx)
    else:
        n_ctx = default_n_ctx

    default_min_words = 20
    min_words = min_words_from_env(default_min_words)

    daemon = SummarizerDaemon(model_path, n_ctx, min_words)
    repl_loop(daemon)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
