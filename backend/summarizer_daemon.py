#!/usr/bin/env python3
"""
Persistent summarizer daemon using llama-cpp-python to avoid reloads.

Protocol (stdin JSON lines):
  {"cmd":"summarize", "file":"/path/to/transcript.txt", "out":"/path/to/summary.txt"}
  {"cmd":"summarize", "text":"...", "out":"/path/to/summary.txt"}
  {"cmd":"followup_email", "summary":"...", "student_name":"...", "instructions":"...", "id":"..."}
  {"cmd":"load_model", "model_path":"/path/to/model.gguf"}

Events (stdout JSON lines):
  {"event":"loaded","model":"..."}
  {"event":"progress","msg":"..."}
  {"event":"summary_start","out":"..."}
  {"event":"summary_delta","text":"...","out":"..."}
  {"event":"done","out":"...","text":"...","secs":1.23}
  {"event":"followup_done","text":"...","secs":1.23,"id":"..."}
  {"event":"followup_error","msg":"...","id":"..."}
  {"event":"error","msg":"...","out":"..."}
"""

import argparse
import json
import os
import re
import sys
import threading
import time
from typing import Callable, Optional

try:
    from llama_cpp import Llama
except Exception as e:
    print(json.dumps({"event": "error", "msg": f"failed to import llama_cpp: {e}"}))
    sys.exit(1)


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
    "Produce a concise summary in 5-7 sentences, grounding every sentence in the transcript text.\n"
    "For summary, it should be a clean looking paragraph, no weird punctuation or line breaks.\n"
    "After the summary, include an 'Action Items:' section only when the transcript clearly supports them.\n"
    "Limit the section to at most five tasks, each introduced with a bullet point that starts with '-' and stays on its own line.\n"
    "Only report a task if it is directly supported by something that happened in the transcript or summary; if no real follow-up is required, write 'Action Items: none.'\n"
    "When you do list actions, mention the topic or person from the transcript that justifies that task so it is clearly traceable.\n"
)
SUMMARY_EXPANSION_SUFFIX = (
    "\nIf the paragraph still has fewer than five sentences, rewrite it so the summary paragraph contains 5-7 sentences, "
    "adding more detail from the transcript while keeping the Action Items section as instructed."
)
EXPANDED_SUMMARY_PROMPT = DEFAULT_PROMPT + SUMMARY_EXPANSION_SUFFIX
MIN_SUMMARY_SENTENCES = 5
ACTION_ITEMS_MARKER = "Action Items:"
SENTENCE_SPLIT_RE = re.compile(r"[^.!?]+[.!?]*")

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


def extract_summary_body(text: str) -> str:
    idx = text.find(ACTION_ITEMS_MARKER)
    return text[:idx] if idx != -1 else text


def count_summary_sentences(text: str) -> int:
    body = extract_summary_body(text).strip()
    if not body:
        return 0
    matches = SENTENCE_SPLIT_RE.findall(body)
    return sum(1 for match in matches if match.strip())


def summarize_with_llm(
    client: Llama,
    text: str,
    prompt: str,
    max_tokens: int = 256,
    on_delta: Optional[Callable[[str], None]] = None,
) -> str:
    full_prompt = prompt + "\n\nTranscript:\n" + text + "\n\nSummary:\n"
    if on_delta:
        try:
            if hasattr(client, "create_completion"):
                resp = client.create_completion(prompt=full_prompt, max_tokens=max_tokens, temperature=0.2, stream=True)
            elif hasattr(client, "create"):
                resp = client.create(prompt=full_prompt, max_tokens=max_tokens, temperature=0.2, stream=True)
            else:
                resp = client(full_prompt, max_tokens=max_tokens, temperature=0.2, stream=True)
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
        except Exception:
            pass
    if hasattr(client, "create_completion"):
        resp = client.create_completion(prompt=full_prompt, max_tokens=max_tokens, temperature=0.2)
    elif hasattr(client, "create"):
        resp = client.create(prompt=full_prompt, max_tokens=max_tokens, temperature=0.2)
    else:
        resp = client(full_prompt, max_tokens=max_tokens, temperature=0.2)
    return resp.get("choices", [{}])[0].get("text", "").strip()


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
    return summarize_with_llm(client, text, DEFAULT_PROMPT, max_tokens=512, on_delta=on_stream)


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
            word_count = count_words(text)
            if word_count < self.min_words:
                msg = f"transcript too short ({word_count} words); skipping summary"
                self.send({"event": "progress", "msg": msg, "context": context})
                summary = "Not enough content to summarize.\nAction Items: none."
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
            try:
                summary = summarize_direct(
                    self.client,
                    text,
                    on_progress=lambda msg: self.send({"event": "progress", "msg": msg, "context": context}),
                    on_stream=lambda delta: self.send({"event": "summary_delta", "text": delta, "out": out_path, "context": context}),
                )
            except Exception as e:
                self.send({"event": "error", "msg": f"summarization error: {e}", "out": out_path, "context": context})
                return
            sentence_count = count_summary_sentences(summary)
            if sentence_count < MIN_SUMMARY_SENTENCES:
                self.send({"event": "progress", "msg": "regenerating summary to reach 5-7 sentences", "context": context})
                try:
                    expanded = summarize_with_llm(self.client, text, EXPANDED_SUMMARY_PROMPT, max_tokens=512)
                    if expanded:
                        summary = expanded
                except Exception as e:
                    self.send({"event": "progress", "msg": f"summary extension failed: {e}", "context": context})
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
            chunk_words = int(obj.get("chunk_words", 800))
            daemon.summarize(text or "", obj.get("out"), chunk_words)
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
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--n-ctx", type=int, default=0)
    parser.add_argument("--min-words", type=int, default=0)
    args = parser.parse_args()

    if not os.path.exists(args.model_path):
        print(json.dumps({"event": "error", "msg": f"model not found: {args.model_path}"}))
        return 2

    env_n_ctx = os.getenv("SUM_N_CTX", "").strip()
    default_n_ctx = 2048
    if args.n_ctx and args.n_ctx > 0:
        n_ctx = args.n_ctx
    elif env_n_ctx.isdigit():
        n_ctx = int(env_n_ctx)
    else:
        n_ctx = default_n_ctx

    default_min_words = 20
    if args.min_words and args.min_words > 0:
        min_words = args.min_words
    else:
        min_words = min_words_from_env(default_min_words)

    daemon = SummarizerDaemon(args.model_path, n_ctx, min_words)
    repl_loop(daemon)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
