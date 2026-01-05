#!/usr/bin/env python3
"""
Local LLM summarizer using llama-cpp-python (ggml models).

Usage examples:
  # Summarize a transcript file and write summary.txt
  python3 backend/summarize_llm.py --model-path models/ggml-model.bin --file sessions/2026-01-01T11-33-17/transcript.txt --out sessions/2026-01-01T11-33-17/summary.txt

This script supports a simple hierarchical summarization: chunk -> summarize chunks -> summarize summaries.
"""

import argparse
import os
import sys
from typing import List

try:
    from llama_cpp import Llama
except Exception as e:
    print(f"Failed to import llama_cpp: {e}", file=sys.stderr)
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
    "Produce a concise summary in 4-6 sentences, and then list 3-6 action items if present.\n"
)

COMBINE_PROMPT = (
    "You are an assistant that synthesizes summaries of multiple meeting sections.\n"
    "Combine the following section summaries into a cohesive final summary (4-8 sentences) and a consolidated action items list.\n"
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
) -> List[str]:
    summaries = []
    for i, ch in enumerate(chunks):
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
) -> str:
    if not summaries:
        return ""
    if len(summaries) == 1:
        return summaries[0]
    current = summaries
    while len(current) > 1:
        combined = "\n\n".join(current)
        if count_words(combined) <= max_input_words:
            return summarize_with_llm(client, combined, prompt, max_tokens=max_tokens)
        combined_chunks = chunk_text_by_words(combined, max_input_words)
        current = summarize_chunks(client, combined_chunks, prompt, max_tokens=256)
    return current[0]


def create_llama(model_path: str, n_ctx: int) -> Llama:
    try:
        return Llama(model_path=model_path, n_ctx=n_ctx)
    except TypeError:
        return Llama(model_path=model_path)


def hierarchical_summarize(model_path: str, text: str, tmp_max_words: int = 800, n_ctx: int = 2048) -> str:
    client = create_llama(model_path, n_ctx)

    # Chunk the transcript
    chunk_word_limit = min(tmp_max_words, estimate_max_words(n_ctx, 256, DEFAULT_PROMPT))
    chunks = chunk_text_by_words(text, max_words=chunk_word_limit)

    chunk_summaries = summarize_chunks(client, chunks, DEFAULT_PROMPT, max_tokens=256)
    max_summary_words = estimate_max_words(n_ctx, 512, COMBINE_PROMPT)
    return summarize_in_passes(client, chunk_summaries, COMBINE_PROMPT, max_tokens=512, max_input_words=max_summary_words)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--file", help="Transcript file to summarize")
    parser.add_argument("--text", help="Raw text to summarize (alternative to --file)")
    parser.add_argument("--out", help="Output summary path (defaults to stdout)")
    parser.add_argument("--chunk-words", type=int, default=800)
    parser.add_argument("--n-ctx", type=int, default=0)
    parser.add_argument("--min-words", type=int, default=0)
    args = parser.parse_args()

    if not os.path.exists(args.model_path):
        print(f"Model not found: {args.model_path}", file=sys.stderr)
        sys.exit(2)

    if args.file:
        if not os.path.exists(args.file):
            print(f"Transcript file not found: {args.file}", file=sys.stderr)
            sys.exit(3)
        with open(args.file, "r", encoding="utf-8") as f:
            text = f.read()
    elif args.text:
        text = args.text
    else:
        print("Either --file or --text must be provided", file=sys.stderr)
        sys.exit(4)

    default_min_words = 20
    if args.min_words and args.min_words > 0:
        min_words = args.min_words
    else:
        min_words = min_words_from_env(default_min_words)
    if count_words(text) < min_words:
        summary = "Not enough content to summarize.\nAction Items: none."
        if args.out:
            os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
            with open(args.out, "w", encoding="utf-8") as f:
                f.write(summary)
            print(f"Wrote summary to {args.out}")
        else:
            print(summary)
        return

    # Run hierarchical summarization
    env_n_ctx = os.getenv("SUM_N_CTX", "").strip()
    default_n_ctx = 2048
    if args.n_ctx and args.n_ctx > 0:
        n_ctx = args.n_ctx
    elif env_n_ctx.isdigit():
        n_ctx = int(env_n_ctx)
    else:
        n_ctx = default_n_ctx

    summary = hierarchical_summarize(args.model_path, text, tmp_max_words=args.chunk_words, n_ctx=n_ctx)

    if args.out:
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(summary)
        print(f"Wrote summary to {args.out}")
    else:
        print(summary)


if __name__ == "__main__":
    main()
