from __future__ import annotations

import difflib
import re
from typing import Dict, List, Sequence, Set

SUMMARY_MARKER = "Summary:"
HIGH_IMPORTANCE_MARKER = "High Importance:"
ACTION_ITEMS_MARKER = "Action Items:"
SECTION_MARKERS = (SUMMARY_MARKER, HIGH_IMPORTANCE_MARKER, ACTION_ITEMS_MARKER)

SENTENCE_SPLIT_RE = re.compile(r"[^.!?\n]+[.!?]*")
SENTENCE_BOUNDARY_RE = re.compile(r"(?<=[.!?])\s+|\n+")
SPEAKER_PREFIX_RE = re.compile(
    r"^\s*(?:\[[^\]]+\]\s*)?(?:speaker\s*\d+|[a-z][a-z0-9 _.'-]{0,30})\s*:\s*",
    re.IGNORECASE,
)
SPEAKER_CAPTURE_RE = re.compile(
    r"^\s*(?:\[[^\]]+\]\s*)?([a-z][a-z0-9 _.'-]{0,30})\s*:\s*",
    re.IGNORECASE,
)
LEADING_BULLET_RE = re.compile(r"^(?:[-*]|\u2022)\s*")
NUMBERED_BULLET_RE = re.compile(r"^\d+[.)]\s*")

ACTION_TRIGGERS = (
    "need",
    "need to",
    "needs to",
    "should",
    "must",
    "have to",
    "will",
    "plan to",
    "follow up",
    "follow-up",
    "next step",
    "next steps",
    "action item",
    "action items",
    "task",
    "assign",
    "assigned",
    "look into",
    "investigate",
    "prepare",
    "deliver",
    "present",
    "confirm",
    "document",
    "research",
    "develop",
    "build",
    "send",
    "share",
    "update",
    "schedule",
    "reach out",
    "email",
    "submit",
    "submitted",
    "complete",
    "finish",
    "attend",
    "office hours",
    "tutoring",
    "gradebook",
    "check in",
    "check-in",
    "meet with",
    "reach professor",
    "email professor",
    "contact advisor",
    "register",
)
ACTION_CONTENT_TRIGGERS = (
    "plan to",
    "follow up",
    "follow-up",
    "task",
    "assign",
    "assigned",
    "look into",
    "investigate",
    "prepare",
    "deliver",
    "present",
    "confirm",
    "document",
    "research",
    "develop",
    "build",
    "send",
    "share",
    "update",
    "schedule",
    "reach out",
    "email",
    "submit",
    "complete",
    "finish",
    "attend",
    "check in",
    "check-in",
    "meet with",
    "contact",
    "register",
    "comment",
    "commit",
    "get",
    "add",
    "ping",
    "call out",
    "aggregate",
    "bucket",
    "review",
    "reserve",
)

HIGH_IMPORTANCE_TRIGGERS = (
    "urgent",
    "critical",
    "high priority",
    "priority",
    "blocker",
    "blocked",
    "risk",
    "at risk",
    "issue",
    "incident",
    "outage",
    "escalation",
    "escalate",
    "deadline",
    "due by",
    "due date",
    "asap",
    "immediately",
    "key decision",
    "decision",
    "decided",
    "compliance",
    "concern",
    "eligibility",
    "ineligible",
    "probation",
    "academic standing",
    "failing",
    "fail",
    "withdrawal",
    "dismissal",
    "hold",
    "attendance risk",
)
HIGH_IMPORTANCE_SCORE_TRIGGERS = tuple(
    trigger for trigger in HIGH_IMPORTANCE_TRIGGERS if trigger not in {"issue", "decision", "concern"}
)

MIN_SUMMARY_SENTENCES = 2
MAX_SUMMARY_SENTENCES = 4
MAX_HIGH_IMPORTANCE_ITEMS = 3
MAX_ACTION_ITEMS = 5
MAX_BULLET_WORDS = 24
ROLE_PREFIXES = ("student", "coach", "advisor", "tutor", "instructor", "professor")
MAX_SUMMARY_SENTENCE_WORDS = 30
BAD_PLACEHOLDER_PHRASES = (
    "owner",
    "topic",
    "due date",
    "action none",
    "action: none",
    "tbd",
)
NEGATED_ACTION_PHRASES = (
    "no action",
    "no follow up",
    "no follow-up",
    "no tasks",
    "no task",
    "no commitments",
    "no commitment",
    "none assigned",
    "not required",
    "nothing to follow up",
)
ACTION_FRAGMENT_PREFIXES = (
    "and ",
    "but ",
    "so ",
    "also ",
    "then ",
    "because ",
)
ACTION_FRAGMENT_ENDINGS = (
    "and",
    "but",
    "so",
    "because",
    "if",
    "when",
    "while",
    "though",
    "although",
    "that",
    "to",
    "for",
    "with",
    "of",
    "on",
    "in",
    "at",
    "by",
    "from",
    "about",
    "around",
)
ACTION_HEDGING_PHRASES = (
    "i think",
    "i guess",
    "maybe",
    "probably",
    "might",
    "could",
    "kind of",
    "sort of",
)
ACTION_IMPERATIVE_RE = re.compile(
    r"^(?:please\s+)?(?:"
    r"email|submit|schedule|share|send|complete|finish|attend|"
    r"check(?:\s+in)?|confirm|prepare|review|update|coordinate|"
    r"contact|register|follow\s*up|reach\s+out|meet(?:\s+with)?|"
    r"comment|get|add|ping|call\s+out|"
    r"look\s+into|investigate"
    r")\b",
    re.IGNORECASE,
)
ACTION_COMMITMENT_RE = re.compile(
    r"^(?:i(?:'m)?|we|you|student|coach|advisor|tutor|instructor|professor|team|[A-Z][a-z]+)\s+"
    r"(?:will|need(?:\s+to)?|needs(?:\s+to)?|should|must|have to|plan to|am\s+going\s+to|are\s+going\s+to|going\s+to|gonna)\b",
    re.IGNORECASE,
)
ACTION_BARE_MODAL_RE = re.compile(
    r"^(?:will|need(?:\s+to)?|needs(?:\s+to)?|should|must|have to|plan to)\s+\w+",
    re.IGNORECASE,
)
ACTION_REQUEST_RE = re.compile(r"^(?:please\s+)?(?:can|could|would)\s+you\s+.+$", re.IGNORECASE)
ACTION_LETS_RE = re.compile(r"^(?:let's|lets)\s+.+$", re.IGNORECASE)
SUMMARY_FRAGMENT_PREFIXES = (
    "and ",
    "but ",
    "so ",
    "or ",
    "then ",
)
SUMMARY_LOW_SIGNAL_PHRASES = (
    "you know",
    "i think",
    "i guess",
    "maybe",
    "sort of",
    "kind of",
)
SUMMARY_DISALLOWED_PHRASES = (
    "i think",
    "i guess",
    "et cetera",
    "etc",
)
SUMMARY_REQUEST_PREFIXES = (
    "can you ",
    "could you ",
    "would you ",
    "let's ",
    "lets ",
)
MONTH_PATTERN = r"(January|February|March|April|May|June|July|August|September|October|November|December)"


def _collapse_spaces(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _normalise_line_endings(text: str) -> str:
    return (text or "").replace("\r\n", "\n").replace("\r", "\n")


def split_sentences(text: str) -> List[str]:
    cleaned = _normalise_line_endings(text).strip()
    if not cleaned:
        return []
    pieces = SENTENCE_BOUNDARY_RE.split(cleaned)
    sentences: List[str] = []
    for piece in pieces:
        sentence = _collapse_spaces(piece)
        if sentence:
            sentences.append(sentence)
    return sentences


def _content_word_set(text: str) -> Set[str]:
    words = re.findall(r"[a-z0-9']+", (text or "").lower())
    return {word for word in words if len(word) >= 3}


def _canonical_key(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def _is_redundant_sentence(candidate: str, existing_sentences: Sequence[str]) -> bool:
    candidate_key = _canonical_key(candidate)
    if not candidate_key:
        return True
    candidate_tokens = set(candidate_key.split())
    for existing in existing_sentences:
        existing_key = _canonical_key(existing)
        if not existing_key:
            continue
        existing_tokens = set(existing_key.split())
        if candidate_key == existing_key:
            return True
        if len(candidate_key) >= 18 and candidate_key in existing_key:
            return True
        if len(existing_key) >= 18 and existing_key in candidate_key:
            return True
        overlap = candidate_tokens & existing_tokens
        if len(overlap) >= 3:
            min_token_count = min(len(candidate_tokens), len(existing_tokens))
            if min_token_count > 0 and (len(overlap) / min_token_count) >= 0.7:
                return True
        if difflib.SequenceMatcher(None, candidate_key, existing_key).ratio() >= 0.74:
            return True
    return False


def _max_sentence_similarity(candidate: str, references: Sequence[str]) -> float:
    candidate_key = _canonical_key(_clean_summary_sentence(candidate))
    if not candidate_key:
        return 0.0
    best = 0.0
    for reference in references:
        reference_key = _canonical_key(_clean_summary_sentence(reference))
        if not reference_key:
            continue
        ratio = difflib.SequenceMatcher(None, candidate_key, reference_key).ratio()
        if ratio > best:
            best = ratio
    return best


def _trim_words(text: str, max_words: int) -> str:
    words = text.split()
    if len(words) <= max_words:
        return text.strip()
    return " ".join(words[:max_words]).rstrip(" ,;:") + "..."


def _trim_words_no_ellipsis(text: str, max_words: int) -> str:
    words = text.split()
    if len(words) <= max_words:
        return text.strip()
    return " ".join(words[:max_words]).rstrip(" ,;:")


def _ensure_sentence_ending(text: str) -> str:
    if not text:
        return text
    if text[-1] in ".!?":
        return text
    return f"{text}."


def _polish_text_snippet(text: str) -> str:
    polished = _collapse_spaces(text)
    polished = re.sub(
        rf"\b{MONTH_PATTERN}\s*([0-9]{{1,2}})\b",
        r"\1 \2",
        polished,
        flags=re.IGNORECASE,
    )
    polished = re.sub(r"\bare currently risk\b", "are currently at risk", polished, flags=re.IGNORECASE)
    polished = re.sub(r"\bis currently risk\b", "is currently at risk", polished, flags=re.IGNORECASE)
    polished = re.sub(r"\bcurrently risk\b", "currently at risk", polished, flags=re.IGNORECASE)
    return _collapse_spaces(polished)


def _format_action_item_text(text: str) -> str:
    item = _collapse_spaces(text).strip(" -\t")
    if not item:
        return item
    if item[0].islower():
        item = item[0].upper() + item[1:]
    lowered = item.lower()
    for role in ROLE_PREFIXES:
        role_with_space = f"{role} "
        role_with_colon = f"{role}:"
        if lowered.startswith(role_with_space):
            remainder = item[len(role_with_space):].strip()
            if remainder:
                item = f"{role.title()}: {remainder}"
            break
        if lowered.startswith(role_with_colon):
            remainder = item[len(role_with_colon):].strip()
            item = f"{role.title()}: {remainder}"
            break
    lowered = item.lower()
    if lowered.startswith("coach: you'll "):
        remainder = item[len("Coach: you'll "):].strip()
        item = f"Student: {remainder}" if remainder else "Student:"
    else:
        match = re.match(r"^Coach:\s+You\s+(will|need to|should|must|have to)\s+(.+)$", item, flags=re.IGNORECASE)
        if match:
            modal = match.group(1).lower()
            remainder = match.group(2).strip()
            if modal == "will":
                item = f"Student: {remainder}"
            else:
                item = f"Student: {modal} {remainder}"
    item = _polish_text_snippet(item)
    return item


def _extract_speaker_role(text: str) -> str:
    candidate = _collapse_spaces(text or "")
    candidate = LEADING_BULLET_RE.sub("", candidate)
    candidate = NUMBERED_BULLET_RE.sub("", candidate)
    match = SPEAKER_CAPTURE_RE.match(candidate)
    if not match:
        return ""
    role = match.group(1).strip()
    if not role:
        return ""
    lowered = role.lower()
    if lowered.startswith("speaker "):
        return ""
    if lowered in ROLE_PREFIXES:
        return lowered.title()
    return ""


def _clean_summary_sentence(text: str) -> str:
    cleaned = _collapse_spaces(SPEAKER_PREFIX_RE.sub("", text or "")).strip()
    cleaned = re.sub(r"^(?:so|and|then|well|okay|ok|you know|um|uh)\s*,?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bet\s*cetera\b.*$", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\betc\.?.*$", "", cleaned, flags=re.IGNORECASE)
    return _collapse_spaces(cleaned)


def _contains_placeholder_phrase(text: str) -> bool:
    lowered = (text or "").lower()
    return any(phrase in lowered for phrase in BAD_PLACEHOLDER_PHRASES)


def _is_sentence_supported_by_transcript(sentence: str, transcript_words: Set[str]) -> bool:
    words = _content_word_set(sentence)
    if not words:
        return False
    overlap = len(words & transcript_words)
    return overlap >= 2 and (overlap / len(words)) >= 0.35


def _is_negated_action_statement(text: str) -> bool:
    lowered = _collapse_spaces(text).lower()
    if not lowered:
        return False
    if lowered.startswith("no "):
        return True
    return any(phrase in lowered for phrase in NEGATED_ACTION_PHRASES)


def _normalise_action_candidate(text: str) -> str:
    candidate = _collapse_spaces(text or "").strip(" -\t")
    if not candidate:
        return ""
    candidate = re.sub(r"^(?:so|and|then|well|okay|ok|you know|um|uh)\s+", "", candidate, flags=re.IGNORECASE)
    candidate = re.sub(r"^(?:i think|i guess)\s+", "", candidate, flags=re.IGNORECASE)
    ask_match = re.search(r"\bthe ask would be\b", candidate, flags=re.IGNORECASE)
    if ask_match:
        tail = candidate[ask_match.end():].strip(" :,-")
        if tail:
            candidate = tail
    request_match = re.match(r"^(?:please\s+)?(?:can|could|would)\s+you\s+(.+)$", candidate, flags=re.IGNORECASE)
    if request_match:
        candidate = f"Please {request_match.group(1).strip()}"
    candidate = re.sub(r"\bet\s*cetera\b.*$", "", candidate, flags=re.IGNORECASE)
    candidate = re.sub(r"\betc\.?.*$", "", candidate, flags=re.IGNORECASE)
    candidate = candidate.strip(" ,;:-")
    return _collapse_spaces(candidate)


def _has_explicit_action_intent(text: str) -> bool:
    candidate = _normalise_action_candidate(text)
    if not candidate:
        return False
    lowered = candidate.lower()
    if lowered.endswith("..."):
        return False
    if any(lowered.startswith(prefix) for prefix in ACTION_FRAGMENT_PREFIXES):
        return False
    if any(phrase in lowered for phrase in ACTION_HEDGING_PHRASES):
        return False
    tokens = re.findall(r"[a-z']+", lowered)
    if tokens and tokens[-1] in ACTION_FRAGMENT_ENDINGS:
        return False
    if ACTION_REQUEST_RE.match(candidate) or ACTION_LETS_RE.match(candidate):
        return True
    return bool(ACTION_COMMITMENT_RE.match(candidate) or ACTION_BARE_MODAL_RE.match(candidate) or ACTION_IMPERATIVE_RE.match(candidate))


def _is_bad_summary_sentence(sentence: str, transcript_words: Set[str]) -> bool:
    cleaned = _collapse_spaces(sentence)
    if not cleaned:
        return True
    lowered = cleaned.lower()
    if len(cleaned.split()) < 5:
        return True
    if any(lowered.startswith(prefix) for prefix in SUMMARY_FRAGMENT_PREFIXES):
        return True
    if any(lowered.startswith(prefix) for prefix in SUMMARY_REQUEST_PREFIXES):
        return True
    if any(phrase in lowered for phrase in SUMMARY_DISALLOWED_PHRASES):
        return True
    if any(phrase in lowered for phrase in SUMMARY_LOW_SIGNAL_PHRASES) and len(cleaned.split()) <= 10:
        return True
    if _contains_placeholder_phrase(cleaned):
        return True
    if not _is_sentence_supported_by_transcript(cleaned, transcript_words):
        return True
    return False


def _is_good_model_summary_sentence(
    sentence: str,
    transcript_words: Set[str],
    transcript_sentences: Sequence[str],
) -> bool:
    if _is_bad_summary_sentence(sentence, transcript_words):
        return False
    return _max_sentence_similarity(sentence, transcript_sentences) >= 0.4


def _score_summary_candidate(sentence: str) -> int:
    cleaned = _clean_summary_sentence(sentence)
    if not cleaned:
        return -999
    score = 0
    if _contains_trigger(cleaned, HIGH_IMPORTANCE_SCORE_TRIGGERS):
        score += 3
    if contains_actionable_language(cleaned):
        score += 2
    lowered = cleaned.lower()
    if "student" in lowered or "coach" in lowered:
        score += 1
    word_count = len(cleaned.split())
    if word_count < 4:
        score -= 1
    return score


def parse_sections(text: str) -> Dict[str, str]:
    raw = _normalise_line_endings(text).strip()
    sections: Dict[str, str] = {marker: "" for marker in SECTION_MARKERS}
    if not raw:
        return sections

    lowered = raw.lower()
    positions = []
    for marker in SECTION_MARKERS:
        idx = lowered.find(marker.lower())
        if idx != -1:
            positions.append((idx, marker))
    positions.sort(key=lambda item: item[0])

    if not positions:
        sections[SUMMARY_MARKER] = raw
        return sections

    first_idx = positions[0][0]
    if first_idx > 0:
        sections[SUMMARY_MARKER] = raw[:first_idx].strip()

    for idx, (start, marker) in enumerate(positions):
        end = positions[idx + 1][0] if idx + 1 < len(positions) else len(raw)
        value = raw[start + len(marker):end].strip()
        if value:
            sections[marker] = value
    return sections


def extract_summary_body(text: str) -> str:
    return parse_sections(text).get(SUMMARY_MARKER, "").strip()


def count_summary_sentences(text: str) -> int:
    body = extract_summary_body(text)
    if not body:
        return 0
    return len(split_sentences(body))


def _contains_trigger(text: str, triggers: Sequence[str]) -> bool:
    lowered = (text or "").lower()
    if not lowered.strip():
        return False
    for trigger in triggers:
        if re.search(rf"\b{re.escape(trigger)}\b", lowered):
            return True
    return False


def contains_actionable_language(text: str) -> bool:
    for sentence in split_sentences(text):
        if not _contains_trigger(sentence, ACTION_TRIGGERS):
            continue
        if _is_negated_action_statement(sentence):
            continue
        return True
    return False


def contains_high_importance_language(text: str) -> bool:
    return _contains_trigger(text, HIGH_IMPORTANCE_TRIGGERS)


def _clean_candidate(text: str) -> str:
    cleaned = _collapse_spaces(text)
    for marker in SECTION_MARKERS:
        if cleaned.lower().startswith(marker.lower()):
            cleaned = cleaned[len(marker):].strip()
    cleaned = LEADING_BULLET_RE.sub("", cleaned)
    cleaned = NUMBERED_BULLET_RE.sub("", cleaned)
    cleaned = SPEAKER_PREFIX_RE.sub("", cleaned)
    cleaned = cleaned.strip(" -\t")
    cleaned = cleaned.rstrip(".;")
    return _collapse_spaces(cleaned)


def parse_bullets(section_text: str, max_items: int) -> List[str]:
    if not section_text:
        return []

    lines = [line.strip() for line in _normalise_line_endings(section_text).splitlines() if line.strip()]
    if len(lines) == 1 and ";" in lines[0]:
        lines = [piece.strip() for piece in lines[0].split(";") if piece.strip()]

    bullets: List[str] = []
    seen = set()
    for raw_line in lines:
        if raw_line.lower().startswith("none"):
            return []
        speaker_role = _extract_speaker_role(raw_line)
        item = _normalise_action_candidate(_clean_candidate(raw_line))
        if not item:
            continue
        if speaker_role and not item.lower().startswith(f"{speaker_role.lower()}:"):
            item = f"{speaker_role}: {item}"
        item = _format_action_item_text(item)
        item = _trim_words(item, MAX_BULLET_WORDS)
        key = _canonical_key(item)
        if not key or key in seen:
            continue
        seen.add(key)
        bullets.append(f"- {item}")
        if len(bullets) >= max_items:
            break
    return bullets


def _is_valid_action_bullet(item: str, transcript_words: Set[str], transcript_sentences: Sequence[str]) -> bool:
    cleaned = _collapse_spaces(item)
    if not cleaned:
        return False
    if _is_negated_action_statement(cleaned):
        return False
    if _contains_placeholder_phrase(cleaned):
        return False
    word_count = len(cleaned.split())
    if word_count < 3:
        return False
    if word_count > MAX_BULLET_WORDS:
        return False
    without_role = re.sub(r"^[A-Za-z][A-Za-z0-9 _.'-]{0,30}:\s*", "", cleaned).strip()
    without_role = _normalise_action_candidate(without_role)
    if not without_role:
        return False
    if not _has_explicit_action_intent(without_role):
        return False
    if not _contains_trigger(without_role, ACTION_CONTENT_TRIGGERS):
        return False
    words = _content_word_set(without_role)
    if not words:
        return False
    overlap = len(words & transcript_words)
    if not (overlap >= 2 or (overlap >= 1 and len(words) <= 4)):
        return False
    return _max_sentence_similarity(without_role, transcript_sentences) >= 0.45


def _extract_trigger_bullets(text: str, triggers: Sequence[str], max_items: int) -> List[str]:
    bullets: List[str] = []
    seen = set()
    for sentence in split_sentences(text):
        if not _contains_trigger(sentence, triggers):
            continue
        if _is_negated_action_statement(sentence):
            continue
        speaker_role = _extract_speaker_role(sentence)
        item = _normalise_action_candidate(_clean_candidate(sentence))
        if not item:
            continue
        if speaker_role and not item.lower().startswith(f"{speaker_role.lower()}:"):
            item = f"{speaker_role}: {item}"
        item = _format_action_item_text(item)
        item = _trim_words(item, MAX_BULLET_WORDS)
        key = _canonical_key(item)
        if not key or key in seen:
            continue
        seen.add(key)
        bullets.append(f"- {item}")
        if len(bullets) >= max_items:
            break
    return bullets


def _extract_explicit_action_bullets(
    text: str,
    transcript_words: Set[str],
    transcript_sentences: Sequence[str],
    max_items: int,
) -> List[str]:
    bullets: List[str] = []
    seen = set()
    for sentence in split_sentences(text):
        if _is_negated_action_statement(sentence):
            continue
        speaker_role = _extract_speaker_role(sentence)
        item = _normalise_action_candidate(_clean_candidate(sentence))
        if not item:
            continue
        if speaker_role and not item.lower().startswith(f"{speaker_role.lower()}:"):
            item = f"{speaker_role}: {item}"
        item = _format_action_item_text(item)
        item = _trim_words(item, MAX_BULLET_WORDS)
        if not _is_valid_action_bullet(item, transcript_words, transcript_sentences):
            continue
        key = _canonical_key(item)
        if not key or key in seen:
            continue
        seen.add(key)
        bullets.append(f"- {item}")
        if len(bullets) >= max_items:
            break
    return bullets


def _role_prefix_re() -> re.Pattern[str]:
    return re.compile(r"^(?:-+\s*)?(?:[A-Za-z][A-Za-z0-9 _.'-]{0,30}:\s*)?", re.IGNORECASE)


def _action_bullet_to_clause(bullet: str) -> str:
    text = _collapse_spaces(bullet or "")
    if text.startswith("- "):
        text = text[2:].strip()
    text = _role_prefix_re().sub("", text).strip()
    text = _normalise_action_candidate(text)
    text = re.split(r"[;,]", text, maxsplit=1)[0].strip()
    text = re.sub(
        r"^(?:please\s+)?(?:we|i|you|they)\s+(?:will|need(?:\s+to)?|needs(?:\s+to)?|should|must|have to|plan to)\s+",
        "",
        text,
        flags=re.IGNORECASE,
    )
    text = text.rstrip(".")
    text = _trim_words_no_ellipsis(text, 12)
    return text


def _enrich_summary_with_actions(summary_body: str, action_bullets: Sequence[str]) -> str:
    sentences = [s for s in split_sentences(summary_body) if s.strip()]
    if len(sentences) >= 3 or not action_bullets:
        return summary_body
    clauses: List[str] = []
    for bullet in action_bullets:
        clause = _action_bullet_to_clause(bullet)
        if not clause:
            continue
        clauses.append(clause)
        if len(clauses) >= 2:
            break
    if not clauses:
        return summary_body
    if len(clauses) == 1:
        followup = f"Agreed follow-ups include {clauses[0]}."
    else:
        followup = f"Agreed follow-ups include {clauses[0]} and {clauses[1]}."
    followup = _ensure_sentence_ending(_trim_words(_polish_text_snippet(followup), MAX_SUMMARY_SENTENCE_WORDS))
    if _is_redundant_sentence(followup, sentences):
        return summary_body
    return f"{summary_body} {followup}".strip()


def _normalise_summary_body(summary_body: str, transcript: str, high_importance_text: str = "") -> str:
    transcript_words = _content_word_set(transcript)
    transcript_sentences = split_sentences(transcript)
    summary_sentences = [_clean_summary_sentence(sentence) for sentence in split_sentences(summary_body)]
    summary_sentences = [
        sentence
        for sentence in summary_sentences
        if sentence and _is_good_model_summary_sentence(sentence, transcript_words, transcript_sentences)
    ]

    if len(summary_sentences) > MAX_SUMMARY_SENTENCES:
        summary_sentences = summary_sentences[:MAX_SUMMARY_SENTENCES]

    if len(summary_sentences) < MIN_SUMMARY_SENTENCES and transcript_sentences:
        scored_candidates = sorted(
            ((_score_summary_candidate(sentence), sentence) for sentence in transcript_sentences),
            key=lambda item: item[0],
            reverse=True,
        )
        for score, sentence in scored_candidates:
            if len(summary_sentences) >= MIN_SUMMARY_SENTENCES:
                break
            if score <= 0:
                continue
            cleaned_sentence = _clean_summary_sentence(sentence)
            if not cleaned_sentence:
                continue
            cleaned_sentence = _trim_words(cleaned_sentence, MAX_SUMMARY_SENTENCE_WORDS)
            if _is_bad_summary_sentence(cleaned_sentence, transcript_words):
                continue
            if _is_redundant_sentence(cleaned_sentence, summary_sentences):
                continue
            summary_sentences.append(cleaned_sentence)

    high_signal = (
        contains_high_importance_language(transcript)
        or contains_high_importance_language(high_importance_text)
    )
    summary_has_high_signal = contains_high_importance_language(" ".join(summary_sentences))
    if high_signal and not summary_has_high_signal:
        candidate_bullets = parse_bullets(high_importance_text, MAX_HIGH_IMPORTANCE_ITEMS)
        if not candidate_bullets:
            candidate_bullets = _extract_trigger_bullets(
                transcript,
                HIGH_IMPORTANCE_TRIGGERS,
                MAX_HIGH_IMPORTANCE_ITEMS,
            )
        for bullet in candidate_bullets:
            candidate = _clean_candidate(bullet)
            if not candidate:
                continue
            candidate = _ensure_sentence_ending(_trim_words(candidate, MAX_BULLET_WORDS))
            if _is_bad_summary_sentence(candidate, transcript_words):
                continue
            if _is_redundant_sentence(candidate, summary_sentences):
                continue
            if len(summary_sentences) < MAX_SUMMARY_SENTENCES:
                summary_sentences.append(candidate)
            elif summary_sentences:
                summary_sentences[-1] = candidate
            break

    if not summary_sentences:
        return "Not enough content to summarize."
    summary_sentences = [
        _ensure_sentence_ending(_trim_words(_polish_text_snippet(sentence), MAX_SUMMARY_SENTENCE_WORDS))
        for sentence in summary_sentences
        if sentence.strip()
    ]
    return " ".join(summary_sentences).strip()


def finalize_action_items_output(summary: str, transcript: str) -> str:
    sections = parse_sections(summary)
    transcript_words = _content_word_set(transcript)
    transcript_sentences = split_sentences(transcript)
    summary_body = _collapse_spaces(sections.get(SUMMARY_MARKER, ""))
    if summary_body:
        summary_body = re.sub(r"\bspeaker\s*([0-9]+)\b", r"Speaker \1", summary_body, flags=re.IGNORECASE)
        summary_body = re.sub(r"([A-Za-z])(\d)", r"\1 \2", summary_body)
        summary_body = re.sub(r"(\d)([A-Za-z])", r"\1 \2", summary_body)
        summary_body = _collapse_spaces(summary_body)
    if not summary_body:
        summary_body = "Not enough content to summarize."

    action_text = sections.get(ACTION_ITEMS_MARKER, "")
    action_bullets = [
        bullet
        for bullet in parse_bullets(action_text, MAX_ACTION_ITEMS)
        if _is_valid_action_bullet(
            bullet[2:] if bullet.startswith("- ") else bullet,
            transcript_words,
            transcript_sentences,
        )
    ]
    if not action_bullets:
        action_bullets = _extract_explicit_action_bullets(
            transcript,
            transcript_words,
            transcript_sentences,
            MAX_ACTION_ITEMS,
        )

    lines = [SUMMARY_MARKER, summary_body, ""]
    if action_bullets:
        lines.append(ACTION_ITEMS_MARKER)
        lines.extend(action_bullets)
    else:
        lines.append(f"{ACTION_ITEMS_MARKER} none.")
    return "\n".join(lines).strip()


def finalize_summary_output(summary: str, transcript: str) -> str:
    sections = parse_sections(summary)
    high_importance_text = sections.get(HIGH_IMPORTANCE_MARKER, "")
    transcript_words = _content_word_set(transcript)
    transcript_sentences = split_sentences(transcript)
    summary_body = _normalise_summary_body(
        sections.get(SUMMARY_MARKER, ""),
        transcript,
        high_importance_text=high_importance_text,
    )
    action_text = sections.get(ACTION_ITEMS_MARKER, "")

    action_bullets = [
        bullet
        for bullet in parse_bullets(action_text, MAX_ACTION_ITEMS)
        if _is_valid_action_bullet(
            bullet[2:] if bullet.startswith("- ") else bullet,
            transcript_words,
            transcript_sentences,
        )
    ]
    if not action_bullets:
        action_bullets = _extract_explicit_action_bullets(
            transcript,
            transcript_words,
            transcript_sentences,
            MAX_ACTION_ITEMS,
        )
    summary_body = _enrich_summary_with_actions(summary_body, action_bullets)

    lines = [SUMMARY_MARKER, summary_body, ""]
    if action_bullets:
        lines.append(ACTION_ITEMS_MARKER)
        lines.extend(action_bullets)
    else:
        lines.append(f"{ACTION_ITEMS_MARKER} none.")
    return "\n".join(lines).strip()
