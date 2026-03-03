import os
import sys

try:
    from llama_cpp import Llama
except Exception as e:
    print(f"Failed to import llama_cpp: {e}", file=sys.stderr)
    sys.exit(1)

try:
    from .summary_formatting import count_summary_sentences, finalize_action_items_output
except ImportError:
    from summary_formatting import count_summary_sentences, finalize_action_items_output


def count_words(text: str) -> int:
    return len(text.split())


def min_words_from_env(default: int) -> int:
    raw = os.getenv("SUM_MIN_WORDS", "").strip()
    if raw.isdigit():
        return max(int(raw), 1)
    return default


DEFAULT_PROMPT = (
    "You are an assistant that summarizes meeting transcripts.\n"
    "Return only these sections in this exact order with the same headings:\n"
    "Summary:\n"
    "Action Items:\n"
    "In 'Summary', write 2-4 concise sentences (max 120 words), grounded only in the transcript.\n"
    "Make sure the summary explicitly includes any high-importance decisions, risks, blockers, or deadlines when they appear.\n"
    "For student success coaching sessions, highlight the student's current goal/progress, primary barriers, and agreed support plan when present.\n"
    "Stay focused on the meeting content and do not add unrelated information.\n"
    "Use normal sentence capitalization and spacing (for example, 'Speaker 2', not 'speaker2' or 'and1').\n"
    "In 'Action Items', include up to five bullets only for explicit follow-up tasks supported by the transcript.\n"
    "Prioritize concrete student-success follow-ups (assignments, outreach, tutoring, scheduling, resource referrals).\n"
    "Each action bullet should include owner/topic and due date or timing when available.\n"
    "Do not output placeholder template text such as 'Owner', 'Topic', or 'Due Date'.\n"
    "If no actionable follow-up is clearly supported, write 'Action Items: none.'\n"
    "Do not invent details and do not add extra sections.\n"
)
SUMMARY_EXPANSION_SUFFIX = (
    "\nIf the Summary section has fewer than two sentences, rewrite the full response so Summary has 2-4 sentences "
    "while keeping Action Items rules unchanged."
)
EXPANDED_SUMMARY_PROMPT = DEFAULT_PROMPT + SUMMARY_EXPANSION_SUFFIX
MIN_SUMMARY_SENTENCES = 2
SHORT_TRANSCRIPT_SUMMARY = "Summary:\nNot enough content to summarize.\n\nAction Items: none."


def summarize_with_llm(client: Llama, text: str, prompt: str, max_tokens: int = 256) -> str:
    full_prompt = prompt + "\n\nTranscript:\n" + text + "\n\nSummary:\n"
    if hasattr(client, "create_completion"):
        resp = client.create_completion(prompt=full_prompt, max_tokens=max_tokens, temperature=0.2)
    elif hasattr(client, "create"):
        resp = client.create(prompt=full_prompt, max_tokens=max_tokens, temperature=0.2)
    else:
        resp = client(full_prompt, max_tokens=max_tokens, temperature=0.2)
    return resp.get("choices", [{}])[0].get("text", "").strip()


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
        summary = SHORT_TRANSCRIPT_SUMMARY
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
    summary = finalize_action_items_output(summary, text)

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
