#!/usr/bin/env python3
"""
Local LLM summarizer using llama-cpp-python (ggml models).

Usage examples:
  # Summarize a transcript file and write summary.txt
  python3 backend/summarize_llm.py --model-path models/ggml-model.bin --file sessions/2026-01-01T11-33-17/transcript.txt --out sessions/2026-01-01T11-33-17/summary.txt

This script summarizes the transcript in a single pass.
"""

import argparse
import os
import sys

try:
    from llama_cpp import Llama
except Exception as e:
    print(f"Failed to import llama_cpp: {e}", file=sys.stderr)
    sys.exit(1)


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


def summarize_with_llm(client: Llama, text: str, prompt: str, max_tokens: int = 256) -> str:
    full_prompt = prompt + "\n\nTranscript:\n" + text + "\n\nSummary:\n"
    if hasattr(client, "create_completion"):
        resp = client.create_completion(prompt=full_prompt, max_tokens=max_tokens, temperature=0.2)
    elif hasattr(client, "create"):
        resp = client.create(prompt=full_prompt, max_tokens=max_tokens, temperature=0.2)
    else:
        resp = client(full_prompt, max_tokens=max_tokens, temperature=0.2)
    return resp.get("choices", [{}])[0].get("text", "").strip()


def create_llama(model_path: str, n_ctx: int) -> Llama:
    try:
        return Llama(model_path=model_path, n_ctx=n_ctx)
    except TypeError:
        return Llama(model_path=model_path)


def summarize_direct(model_path: str, text: str, n_ctx: int = 2048) -> str:
    client = create_llama(model_path, n_ctx)
    return summarize_with_llm(client, text, DEFAULT_PROMPT, max_tokens=512)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--file", help="Transcript file to summarize")
    parser.add_argument("--text", help="Raw text to summarize (alternative to --file)")
    parser.add_argument("--out", help="Output summary path (defaults to stdout)")
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

    summary = summarize_direct(args.model_path, text, n_ctx=n_ctx)

    if args.out:
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(summary)
        print(f"Wrote summary to {args.out}")
    else:
        print(summary)


if __name__ == "__main__":
    main()
