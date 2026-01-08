#!/usr/bin/env python3
"""
Persistent summarizer daemon using llama-cpp-python to avoid reloads.

Protocol (stdin JSON lines):
  {"cmd":"summarize", "file":"/path/to/transcript.txt", "out":"/path/to/summary.txt"}
  {"cmd":"summarize", "text":"...", "out":"/path/to/summary.txt"}
  {"cmd":"load_model", "model_path":"/path/to/model.gguf"}

Events (stdout JSON lines):
  {"event":"loaded","model":"..."}
  {"event":"progress","msg":"..."}
  {"event":"done","out":"...","text":"...","secs":1.23}
  {"event":"error","msg":"...","out":"..."}
"""

import argparse
import json
import os
import re
import sys
import threading
import time
from typing import Callable, List, Optional

os.environ.setdefault("LLAMA_CPP_LOG_LEVEL", "ERROR")

try:
    from llama_cpp import Llama
except Exception as e:
    print(json.dumps({"event": "error", "msg": f"failed to import llama_cpp: {e}"}))
    sys.exit(1)


def chunk_text_by_words(text: str, max_words: int = 800) -> List[str]:
    words = text.split()
    chunks = []
    for i in range(0, len(words), max_words):
        chunk = " ".join(words[i : i + max_words])
        chunks.append(chunk)
    return chunks


def count_words(text: str) -> int:
    return len(text.split())


def min_words_from_env(default: int) -> int:
    raw = os.getenv("SUM_MIN_WORDS", "").strip()
    if raw.isdigit():
        return max(int(raw), 1)
    return default


DEFAULT_PROMPT = (
    "You are an assistant that summarizes meeting transcripts.\n"
    "Produce a concise summary in 5-7 sentences.\n"
    "If there are explicit action items, include a section titled 'Action Items:' with 3-6 bullets.\n"
    "If there are no action items, omit the Action Items section entirely.\n"
)

FAST_CHUNK_PROMPT = (
    "You are an assistant that summarizes a short transcript snippet.\n"
    "Write 2-3 concise sentences capturing the key points.\n"
    "Do not include action items in chunk summaries.\n"
)

COMBINE_PROMPT = (
    "You are an assistant that synthesizes summaries of multiple meeting sections.\n"
    "Combine the following section summaries into a cohesive summary (6-10 sentences).\n"
    "If there are explicit action items, include a section titled 'Action Items:' with bullets.\n"
    "If there are no action items, omit the Action Items section entirely.\n"
)


def summarize_with_llm(client: Llama, text: str, prompt: str, max_tokens: int = 256) -> str:
    full_prompt = prompt + "\n\nTranscript:\n" + text + "\n\nSummary:\n"
    if hasattr(client, "create_completion"):
        resp = client.create_completion(prompt=full_prompt, max_tokens=max_tokens, temperature=0.2)
    elif hasattr(client, "create"):
        resp = client.create(prompt=full_prompt, max_tokens=max_tokens, temperature=0.2)
    else:
        resp = client(full_prompt, max_tokens=max_tokens, temperature=0.2)
    return resp.get("choices", [{}])[0].get("text", "").strip()


def estimate_max_words(n_ctx: int, max_new_tokens: int, prompt: str) -> int:
    tokens_per_word = 1.5
    prompt_words = max(count_words(prompt), 1)
    prompt_tokens = int(prompt_words * tokens_per_word)
    available_tokens = max(n_ctx - max_new_tokens - prompt_tokens - 64, 128)
    return max(120, int(available_tokens / tokens_per_word))


def summarize_chunks(
    client: Llama,
    chunks: List[str],
    prompt: str,
    max_tokens: int,
    on_progress: Optional[Callable[[str, Optional[int], Optional[int]], None]],
) -> List[str]:
    summaries = []
    total = max(len(chunks), 1)
    start_all = time.time()
    for i, ch in enumerate(chunks):
        if on_progress:
            percent = ((i + 1) / total) * 80.0
            elapsed = time.time() - start_all
            eta_secs = None
            if i > 0:
                avg = elapsed / (i + 1)
                remaining = avg * (total - (i + 1))
                eta_secs = max(0, int(remaining))
            on_progress(f"summarizing chunk {i+1}/{len(chunks)}", percent, eta_secs)
        chunk_prompt = prompt + f"Chunk {i+1}/{len(chunks)} summary."
        s = summarize_with_llm(client, ch, chunk_prompt, max_tokens=max_tokens)
        summaries.append(s)
    return summaries


def summarize_in_passes(
    client: Llama,
    summaries: List[str],
    prompt: str,
    max_tokens: int,
    max_input_words: int,
    on_progress: Optional[Callable[[str, Optional[int], Optional[int]], None]],
) -> str:
    if not summaries:
        return ""
    if len(summaries) == 1:
        return summaries[0]
    round_num = 1
    current = summaries
    while len(current) > 1:
        combined = "\n\n".join(current)
        if count_words(combined) <= max_input_words:
            if on_progress:
                on_progress("combining section summaries", 90, None)
            return summarize_with_llm(client, combined, prompt, max_tokens=max_tokens)
        if on_progress:
            on_progress(f"combining summaries pass {round_num} ({len(current)} items)", 90, None)
        combined_chunks = chunk_text_by_words(combined, max_input_words)
        next_summaries = summarize_chunks(client, combined_chunks, prompt, max_tokens=256, on_progress=on_progress)
        current = next_summaries
        round_num += 1
    return current[0]


def max_tokens_from_env(var_name: str, default: int, minimum: int) -> int:
    raw = os.getenv(var_name, "").strip()
    if raw.isdigit():
        return max(int(raw), minimum)
    return default


def hierarchical_summarize(
    client: Llama,
    text: str,
    tmp_max_words: int = 800,
    n_ctx: int = 2048,
    on_progress: Optional[Callable[[str, Optional[int], Optional[int]], None]] = None,
) -> str:
    chunk_max_tokens = max_tokens_from_env("SUM_MAX_TOKENS", 192, 64)
    combine_max_tokens = max_tokens_from_env("SUM_COMBINE_MAX_TOKENS", 256, 96)
    chunk_word_limit = min(tmp_max_words, estimate_max_words(n_ctx, 256, DEFAULT_PROMPT))
    chunks = chunk_text_by_words(text, max_words=chunk_word_limit)
    if on_progress:
        on_progress(f"summarizing {len(chunks)} chunk(s)", 5, None)
    chunk_summaries = summarize_chunks(
        client,
        chunks,
        DEFAULT_PROMPT,
        max_tokens=chunk_max_tokens,
        on_progress=on_progress,
    )
    max_summary_words = estimate_max_words(n_ctx, 512, COMBINE_PROMPT)
    return summarize_in_passes(
        client,
        chunk_summaries,
        COMBINE_PROMPT,
        max_tokens=combine_max_tokens,
        max_input_words=max_summary_words,
        on_progress=on_progress,
    )


def create_llama(model_path: str, n_ctx: int) -> Llama:
    try:
        return Llama(model_path=model_path, n_ctx=n_ctx, verbose=False)
    except TypeError:
        return Llama(model_path=model_path, verbose=False)


ACTION_VERB_RE = re.compile(
    r"^(schedule|send|follow up|follow-up|implement|decide|review|fix|prepare|update|write|"
    r"create|plan|set|reach out|confirm|share|draft|compile|check|analyze|investigate|"
    r"deliver|collect|coordinate|book|arrange|notify|email|call|meet|finalize|submit|"
    r"approve|summarize|sync|assign|document|test)\b",
    flags=re.IGNORECASE,
)
DATE_HINT_RE = re.compile(
    r"\b("
    r"(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\w*"
    r"|mon(day)?|tue(sday)?|wed(nesday)?|thu(rsday)?|fri(day)?|sat(urday)?|sun(day)?"
    r"|tomorrow|today|next week|next month|this week|this month|by\b|due\b|deadline"
    r")\b",
    flags=re.IGNORECASE,
)
NUMERIC_DATE_RE = re.compile(r"\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b")


def strip_empty_action_items(text: str) -> str:
    lines = text.splitlines()
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if re.match(r"^\s*Action Items\s*:\s*$", line, flags=re.IGNORECASE):
            j = i + 1
            items = []
            while j < len(lines) and lines[j].strip():
                items.append(lines[j])
                j += 1
            combined = " ".join(item.strip() for item in items)
            if not items or re.search(r"\b(no action items?|none|n/?a)\b", combined, flags=re.IGNORECASE):
                i = j
                continue
            has_action = False
            for raw in items:
                cleaned = re.sub(r"^[\s\-\*\d\.\)\:]+", "", raw).strip()
                if ACTION_VERB_RE.match(cleaned):
                    has_action = True
                    break
                if DATE_HINT_RE.search(cleaned) or NUMERIC_DATE_RE.search(cleaned):
                    has_action = True
                    break
            if not has_action:
                i = j
                continue
        out.append(line)
        i += 1
    return "\n".join(out).strip()


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

    def summarize(self, text: str, out_path: Optional[str], chunk_words: int, quiet: bool, fast: bool):
        with self.lock:
            if not self.client:
                self.send({"event": "error", "msg": "model not loaded", "out": out_path})
                return
            word_count = count_words(text)
            if word_count < self.min_words:
                msg = f"transcript too short ({word_count} words); skipping summary"
                if not quiet:
                    self.send({"event": "progress", "msg": msg})
                summary = "Not enough content to summarize."
                if out_path:
                    try:
                        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
                        with open(out_path, "w", encoding="utf-8") as f:
                            f.write(summary)
                    except Exception as e:
                        self.send({"event": "error", "msg": f"failed to write summary: {e}", "out": out_path})
                        return
                self.send({"event": "done", "out": out_path, "text": summary, "secs": 0})
                return
            start = time.time()
            try:
                progress_cb = None
                if not quiet:
                    progress_cb = lambda msg, pct=None, eta=None: self.send({"event": "progress", "msg": msg, "percent": pct, "eta_secs": eta})
                if fast:
                    max_tokens = max_tokens_from_env("SUM_CHUNK_FAST_TOKENS", 120, 48)
                    summary = summarize_with_llm(self.client, text, FAST_CHUNK_PROMPT, max_tokens=max_tokens)
                else:
                    summary = hierarchical_summarize(
                        self.client,
                        text,
                        tmp_max_words=chunk_words,
                        n_ctx=self.n_ctx,
                        on_progress=progress_cb,
                    )
                summary = strip_empty_action_items(summary)
            except Exception as e:
                self.send({"event": "error", "msg": f"summarization error: {e}", "out": out_path})
                return
            if not quiet:
                self.send({"event": "progress", "msg": "finalizing summary", "percent": 100, "eta_secs": 0})
            dur = time.time() - start
            if out_path:
                try:
                    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
                    with open(out_path, "w", encoding="utf-8") as f:
                        f.write(summary)
                except Exception as e:
                    self.send({"event": "error", "msg": f"failed to write summary: {e}", "out": out_path})
                    return
            self.send({"event": "done", "out": out_path, "text": summary, "secs": dur})


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
            quiet = bool(obj.get("quiet"))
            fast = bool(obj.get("fast"))
            daemon.summarize(text or "", obj.get("out"), chunk_words, quiet, fast)
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
