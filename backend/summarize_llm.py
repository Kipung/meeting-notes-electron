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
import re
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
    "Produce a concise summary in 5-7 sentences, grounding every sentence in the transcript text.\n"
    "For summary, keep it as a tidy paragraph with normal punctuation and no awkward line breaks.\n"
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


def summarize_with_llm(client: Llama, text: str, prompt: str, max_tokens: int = 256) -> str:
    full_prompt = prompt + "\n\nTranscript:\n" + text + "\n\nSummary:\n"
    if hasattr(client, "create_completion"):
        resp = client.create_completion(prompt=full_prompt, max_tokens=max_tokens, temperature=0.2)
    elif hasattr(client, "create"):
        resp = client.create(prompt=full_prompt, max_tokens=max_tokens, temperature=0.2)
    else:
        resp = client(full_prompt, max_tokens=max_tokens, temperature=0.2)
    return resp.get("choices", [{}])[0].get("text", "").strip()


def extract_summary_body(text: str) -> str:
    idx = text.find(ACTION_ITEMS_MARKER)
    return text[:idx] if idx != -1 else text


def count_summary_sentences(text: str) -> int:
    body = extract_summary_body(text).strip()
    if not body:
        return 0
    matches = SENTENCE_SPLIT_RE.findall(body)
    return sum(1 for match in matches if match.strip())


def ensure_min_sentences(summary: str, transcript: str, client: Llama) -> str:
    if count_summary_sentences(summary) >= MIN_SUMMARY_SENTENCES:
        return summary
    try:
        expanded = summarize_with_llm(client, transcript, EXPANDED_SUMMARY_PROMPT, max_tokens=512)
        if expanded:
            return expanded
    except Exception as e:
        print(f"warning: summary expansion failed: {e}", file=sys.stderr)
    return summary


def create_llama(model_path: str, n_ctx: int) -> Llama:
    try:
        return Llama(model_path=model_path, n_ctx=n_ctx)
    except TypeError:
        return Llama(model_path=model_path)


def summarize_direct(model_path: str, text: str, n_ctx: int = 2048):
    client = create_llama(model_path, n_ctx)
    summary = summarize_with_llm(client, text, DEFAULT_PROMPT, max_tokens=512)
    return client, summary


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

    client, summary = summarize_direct(args.model_path, text, n_ctx=n_ctx)
    summary = ensure_min_sentences(summary, text, client)

    if args.out:
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(summary)
        print(f"Wrote summary to {args.out}")
    else:
        print(summary)


if __name__ == "__main__":
    main()
