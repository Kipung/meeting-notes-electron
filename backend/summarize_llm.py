#!/usr/bin/env python3
"""
Local LLM summarizer using llama-cpp-python (ggml models).

Usage:
  SUMMODEL_PATH=models/ggml-model.bin SUM_TRANSCRIPT_FILE=sessions/2026-01-01T11-33-17/transcript.txt SUM_SUMMARY_OUT=sessions/2026-01-01T11-33-17/summary.txt python3 backend/summarize_llm.py
  # or set SUM_TEXT instead of SUM_TRANSCRIPT_FILE when the transcript is already in memory

This script summarizes the transcript in a single pass.
"""
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
    model_path = (os.getenv("SUMMODEL_PATH") or os.getenv("SUMMODEL") or "").strip()
    if not model_path:
        print("Model path not configured; set SUMMODEL_PATH or SUMMODEL", file=sys.stderr)
        sys.exit(2)

    if not os.path.exists(model_path):
        print(f"Model not found: {model_path}", file=sys.stderr)
        sys.exit(2)

    transcript_file = os.getenv("SUM_TRANSCRIPT_FILE")
    text_env = os.getenv("SUM_TEXT")
    if transcript_file:
        if not os.path.exists(transcript_file):
            print(f"Transcript file not found: {transcript_file}", file=sys.stderr)
            sys.exit(3)
        with open(transcript_file, "r", encoding="utf-8") as f:
            text = f.read()
    elif text_env is not None:
        text = text_env
    else:
        print("SUM_TRANSCRIPT_FILE or SUM_TEXT must be provided", file=sys.stderr)
        sys.exit(4)

    default_min_words = 20
    min_words = min_words_from_env(default_min_words)
    if count_words(text) < min_words:
        summary = "Not enough content to summarize.\nAction Items: none."
        output_path = os.getenv("SUM_SUMMARY_OUT")
        if output_path:
            os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
            with open(output_path, "w", encoding="utf-8") as f:
                f.write(summary)
            print(f"Wrote summary to {output_path}")
        else:
            print(summary)
        return

    env_n_ctx = os.getenv("SUM_N_CTX", "").strip()
    default_n_ctx = 2048
    if env_n_ctx.isdigit():
        n_ctx = int(env_n_ctx)
    else:
        n_ctx = default_n_ctx

    client, summary = summarize_direct(model_path, text, n_ctx=n_ctx)
    summary = ensure_min_sentences(summary, text, client)

    output_path = os.getenv("SUM_SUMMARY_OUT")
    if output_path:
        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(summary)
        print(f"Wrote summary to {output_path}")
    else:
        print(summary)


if __name__ == "__main__":
    main()
