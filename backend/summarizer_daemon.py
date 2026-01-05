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
import sys
import threading
import time
from typing import Callable, List, Optional

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
    "Produce a concise summary in 5-7 sentences, and then list 3-6 action items if present.\n"
)

COMBINE_PROMPT = (
    "You are an assistant that synthesizes summaries of multiple meeting sections.\n"
    "Combine the following section summaries into a cohesive summary (6-10 sentences)\n"
    "and a consolidated action items list.\n"
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
    on_progress: Optional[Callable[[str], None]],
) -> List[str]:
    summaries = []
    for i, ch in enumerate(chunks):
        if on_progress:
            on_progress(f"summarizing chunk {i+1}/{len(chunks)}")
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
    on_progress: Optional[Callable[[str], None]],
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
                on_progress("combining section summaries")
            return summarize_with_llm(client, combined, prompt, max_tokens=max_tokens)
        if on_progress:
            on_progress(f"combining summaries pass {round_num} ({len(current)} items)")
        combined_chunks = chunk_text_by_words(combined, max_input_words)
        next_summaries = summarize_chunks(client, combined_chunks, prompt, max_tokens=256, on_progress=on_progress)
        current = next_summaries
        round_num += 1
    return current[0]


def hierarchical_summarize(
    client: Llama,
    text: str,
    tmp_max_words: int = 800,
    n_ctx: int = 2048,
    on_progress: Optional[Callable[[str], None]] = None,
) -> str:
    chunk_word_limit = min(tmp_max_words, estimate_max_words(n_ctx, 256, DEFAULT_PROMPT))
    chunks = chunk_text_by_words(text, max_words=chunk_word_limit)
    if on_progress:
        on_progress(f"summarizing {len(chunks)} chunk(s)")
    chunk_summaries = summarize_chunks(
        client,
        chunks,
        DEFAULT_PROMPT,
        max_tokens=256,
        on_progress=on_progress,
    )
    max_summary_words = estimate_max_words(n_ctx, 512, COMBINE_PROMPT)
    return summarize_in_passes(
        client,
        chunk_summaries,
        COMBINE_PROMPT,
        max_tokens=512,
        max_input_words=max_summary_words,
        on_progress=on_progress,
    )


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

    def summarize(self, text: str, out_path: Optional[str], chunk_words: int):
        with self.lock:
            if not self.client:
                self.send({"event": "error", "msg": "model not loaded", "out": out_path})
                return
            word_count = count_words(text)
            if word_count < self.min_words:
                msg = f"transcript too short ({word_count} words); skipping summary"
                self.send({"event": "progress", "msg": msg})
                summary = "Not enough content to summarize.\nAction Items: none."
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
                summary = hierarchical_summarize(
                    self.client,
                    text,
                    tmp_max_words=chunk_words,
                    n_ctx=self.n_ctx,
                    on_progress=lambda msg: self.send({"event": "progress", "msg": msg}),
                )
            except Exception as e:
                self.send({"event": "error", "msg": f"summarization error: {e}", "out": out_path})
                return
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
            daemon.summarize(text or "", obj.get("out"), chunk_words)
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
