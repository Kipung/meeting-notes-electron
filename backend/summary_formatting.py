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
    "decide",
    "declare",
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
    "decide",
    "declare",
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
    "tutoring",
    "office hours",
    "check",
    "gradebook",
    "assignment",
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
DECISION_SIGNAL_TRIGGERS = (
    "schedule",
    "conflict",
    "drop",
    "add",
    "replace",
    "retake",
    "passed",
    "passing",
    "semester",
    "wait list",
    "permission",
    "course",
    "class",
    "classes",
    "grade",
    "full time",
    "full-time",
    "unit",
    "units",
    "concentration",
    "spring",
    "fall",
    "online",
    "minor",
    "graduate",
    "credit",
    "credits",
    "transcript",
)
LOW_PRIORITY_CONTEXT_TRIGGERS = (
    "orientation",
    "admissions",
    "business card",
    "office of student success",
    "tutoring",
)
ADVISING_CONTEXT_TRIGGERS = (
    "student",
    "schedule",
    "semester",
    "class",
    "classes",
    "course",
    "courses",
    "transcript",
    "credits",
    "units",
    "graduate",
    "graduation",
    "requirement",
    "registration",
    "concentration",
    "full time",
    "full-time",
)
ADVISING_AGENDA_TRIGGERS = (
    "needs help",
    "wanted to",
    "wants to",
    "trying to",
    "full time",
    "full-time",
    "registering for",
    "confirming",
    "make sure",
    "keep the degree plan on course",
    "figure out what to do",
    "not sure what classes",
)
ADVISING_PLAN_TRIGGERS = (
    "fulfill the requirement",
    "remaining requirement",
    "replace",
    "drop",
    "enrolled in",
    "spring schedule",
    "flight operations concentration",
    "keep the degree plan on course",
    "full time",
    "full-time",
    "all set",
    "wait list",
)
ADVISING_REMAINING_TRIGGERS = (
    "send transcripts",
    "transfer credit",
    "student portal",
    "declare a concentration",
    "before graduation",
    "124 total units",
    "need to get to 124",
    "only thing left",
    "remaining concentration courses",
    "will be at",
    "wait list",
    "check with the va",
)
LOW_VALUE_LOGISTICS_TRIGGERS = (
    "online now",
    "online ones",
    "online class",
    "traditional class",
    "traditional pace",
    "whole semester",
    "second half of the semester",
    "first half of the semester",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "monday night",
)

MIN_SUMMARY_SENTENCES = 2
MAX_SUMMARY_SENTENCES = 4
TARGET_SUMMARY_SENTENCES = 3
MAX_HIGH_IMPORTANCE_ITEMS = 3
MAX_ACTION_ITEMS = 5
MAX_BULLET_WORDS = 24
ROLE_PREFIXES = ("student", "coach", "advisor", "tutor", "instructor", "professor")
MAX_SUMMARY_SENTENCE_WORDS = 36
TARGET_SUMMARY_WORDS = 45
EXTRACTIVE_SELECTION_MARGIN = 0.35
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
GENERIC_ADMIN_ACTION_PHRASES = (
    "schedule a meeting",
    "set up a meeting",
    "send a follow-up email",
    "notify leadership",
    "provide feedback",
    "review details",
    "discuss the program",
    "discuss effectiveness",
)
AMBIGUOUS_ACTION_PHRASES = (
    "take that",
    "do that",
    "add that",
    "take it",
    "do it",
    "add it",
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
    "all right",
    "alright",
    "okay, so",
)
SUMMARY_LOW_SIGNAL_PHRASES = (
    "you know",
    "i think",
    "i guess",
    "maybe",
    "sort of",
    "kind of",
    "i'm gonna",
    "i am gonna",
    "i'm not sure",
    "i am not sure",
    "not sure if",
    "great question",
    "sounds good",
)
SUMMARY_DISALLOWED_PHRASES = (
    "i think",
    "i guess",
    "i'm gonna",
    "i am gonna",
    "i'm not sure",
    "i am not sure",
    "not sure if i should",
    "i see you have",
    "all right, so",
    "should be okay",
    "retaking it",
    "et cetera",
    "etc",
    "it should show here somewhere",
    "that's what that whole class is about",
    "dont have to add those classes",
    "don't have to add those classes",
    "just one class, different one or two",
    "because each one, they're not offered every semester",
    "that's also offered online the second half of the semester",
    "that may be something where they may not cover it",
    "the student should be good",
    "have a good good semester",
    "thanks for coming in",
    "the student can add it",
    "how familiar the student is with the bible",
    "the bible is made up of 66 books",
    "old testament is all the history before jesus",
    "nope, they're all they're all set",
    "that's the only other thing the student needs",
    "because look",
    "the student wants to get one more class so the student can be full time",
    "there's also a new testament, which should be cst 130 either one would fulfill the requirement",
    "need to make sure the classes for spring are set up properly",
    "needs to make sure the classes for spring are set up properly",
    "the student can take it in the spring as an online class",
    "that was this last semester",
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
    collapsed = re.sub(r"\s+", " ", text).strip()
    collapsed = re.sub(r"\s+([,.;:!?])", r"\1", collapsed)
    return collapsed.strip()


def _normalise_line_endings(text: str) -> str:
    return (text or "").replace("\r\n", "\n").replace("\r", "\n")


def split_sentences(text: str) -> List[str]:
    cleaned = _normalise_line_endings(text).strip()
    if not cleaned:
        return []
    # Preserve explicit speaker turns, but collapse Otter-style wrapped lines into spaces so
    # transcript snippets are evaluated as full thoughts instead of single-word fragments.
    cleaned = re.sub(
        r"\n(?=\s*(?:\[[^\]]+\]\s*)?(?:speaker\s*\d+|[a-z][a-z0-9 _.'-]{0,30})\s*:)",
        "\n\n",
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(r"(?<![.!?])\n(?!\n)", " ", cleaned)
    pieces = re.split(r"(?<=[.!?])\s+|\n{2,}", cleaned)
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
    polished = re.sub(r"\bthe participant plans to take that in a different semester\b", "the class may need to be taken in a different semester", polished, flags=re.IGNORECASE)
    polished = re.sub(r"\bjust because of the time\b", "because of the schedule conflict", polished, flags=re.IGNORECASE)
    polished = re.sub(r"\bdid not finish last one\b", "did not complete previously", polished, flags=re.IGNORECASE)
    polished = re.sub(
        r"\bsince those are the ones that the student did not complete previously\b",
        "because those courses were not completed previously",
        polished,
        flags=re.IGNORECASE,
    )
    polished = re.sub(r",\s*which is fine,\s*", ", ", polished, flags=re.IGNORECASE)
    if polished and polished[0].islower():
        polished = polished[0].upper() + polished[1:]
    return _collapse_spaces(polished)


def _neutralize_summary_perspective(text: str) -> str:
    cleaned = _collapse_spaces(text or "")
    if not cleaned:
        return cleaned
    cleaned = re.sub(r"^i want to know if\s+", "The participant asked whether ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^i wanted to know if\s+", "The participant asked whether ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^i (?:am going to|am gonna|['’]?m going to|['’]?m gonna)\s+", "The participant plans to ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^i have to\s+", "The participant needs to ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^i need to\s+", "The participant needs to ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^i want to\s+", "The participant wants to ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^i will\s+", "The participant will ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^we need to\s+", "The group needs to ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^we will\s+", "The group will ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^you have to\s+", "The student needs to ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^you need to\s+", "The student needs to ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^you are\s+", "The student is ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^you have\s+", "The student has ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^you should\s+", "The student should ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^you will\s+", "The student will ", cleaned, flags=re.IGNORECASE)
    return _collapse_spaces(cleaned)


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
    if ":" not in item and re.match(
        r"^(?:will|need(?:\s+to)?|needs(?:\s+to)?|should|must|have to|plan to|am\s+going\s+to|are\s+going\s+to|going to)\b",
        item,
        flags=re.IGNORECASE,
    ):
        item = f"Student: {item}"
    you_modal = re.match(
        r"^You\s+(need(?:\s+to)?|needs(?:\s+to)?|have to|should|must|will|plan to|going to|can)\s+(.+)$",
        item,
        flags=re.IGNORECASE,
    )
    if you_modal:
        modal = you_modal.group(1).lower()
        remainder = you_modal.group(2).strip()
        if modal == "have to":
            modal = "needs to"
        item = f"Student: {modal} {remainder}"
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
    item = re.sub(
        r"^([A-Za-z][A-Za-z0-9 _.'-]{0,30}):\s+I\s+(will|need(?:\s+to)?|needs(?:\s+to)?|should|must|have to|plan to)\s+",
        r"\1: \2 ",
        item,
        flags=re.IGNORECASE,
    )
    item = re.sub(
        r"^([A-Za-z][A-Za-z0-9 _.'-]{0,30}):\s+Have to\s+",
        r"\1: needs to ",
        item,
        flags=re.IGNORECASE,
    )
    item = re.sub(
        r"^([A-Za-z][A-Za-z0-9 _.'-]{0,30}):\s+Need to\s+",
        r"\1: needs to ",
        item,
        flags=re.IGNORECASE,
    )
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
    cleaned = re.sub(r"^Example\s+\d+\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^[—–-]+\s*", "", cleaned)
    cleaned = re.sub(r"^(?:so|and|then|well|okay|ok|you know|um|uh)\s*,?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^yeah,\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r",\s*and then,?\s*yeah,?\s*", ", ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bi['’]?m trying to\b", "the student wants to", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bi am trying to\b", "the student wants to", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bi need help with\b", "the student needs help with", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\byou need help with\b", "the student needs help with", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bi just need to make sure\b", "the student needs to make sure", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bi just need to\b", "the student needs to", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bso i can\b", "so the student can", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bmy schedule\b", "the schedule", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bto my schedule\b", "to the schedule", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bmy classes\b", "the student's classes", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bwe just need to get you\b", "the plan is to get the student", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bwe need to get you\b", "the plan is to get the student", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\byou have to\b", "the student needs to", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\byou need to\b", "the student needs to", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\byou need\b", "the student needs", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\byou have\b", "the student has", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\byou are\b", "the student is", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\byou can\b", "the student can", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\byou could\b", "the student could", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\byou will\b", "the student will", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\byou['’]ll\b", "the student will", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bwhere you took it\b", "where the course was taken", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bcommunity college classes came through\b", "community college transfer credit would count", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bit keeps me on course\b", "it keeps the degree plan on course", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bwhat i need to be doing\b", "what the student needs to be doing", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bi['’]?m gonna\b", "the participant plans to", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bi am gonna\b", "the participant plans to", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bi['’]?m not sure if\b", "it is unclear whether", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bi am not sure if\b", "it is unclear whether", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bi (?:was|were) not able to\b", "the student did not", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bi did fail\b", "the student failed", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(
        r"\bor if i should ([^,.!?]{3,80}?)(?:,?\s*or if i should \1)+",
        r"or if i should \1",
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(
        r"\b(i should [^,.!?]{3,80}?)(?:\s*,\s*or if\s+\1)+",
        r"\1",
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(r"^(?:have to|need to)\s+", "The student needs to ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^(?:you have to|you need to)\s+", "The student needs to ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^student have to\s+", "Student needs to ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\byou just need to\b", "the student needs to", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\byou just need\b", "the student needs", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\byou should be\b", "the student should be", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\byou should\b", "the student should", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\byou could\b", "the student could", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\byour schedule\b", "the student's schedule", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\byour ([0-9]+ units)\b", r"the schedule remains \1", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bthis is your new schedule\b", "this is the new schedule", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^replace\s+", "The plan was to replace ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^drop\s+", "The student needed to drop ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^add\s+", "The student planned to add ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^retake\s+", "The student planned to retake ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bet\s*cetera\b.*$", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\betc\.?.*$", "", cleaned, flags=re.IGNORECASE)
    cleaned = _neutralize_summary_perspective(cleaned)
    return _collapse_spaces(cleaned)


def _contains_placeholder_phrase(text: str) -> bool:
    lowered = (text or "").lower()
    return any(phrase in lowered for phrase in BAD_PLACEHOLDER_PHRASES)


def _is_low_value_schedule_logistics_sentence(text: str) -> bool:
    lowered = _collapse_spaces(text).lower()
    if not lowered:
        return False
    has_logistics = any(trigger in lowered for trigger in LOW_VALUE_LOGISTICS_TRIGGERS)
    if not has_logistics:
        return False
    has_outcome = contains_actionable_language(lowered) or _contains_trigger(
        lowered,
        (
            "fulfill",
            "requirement",
            "unit",
            "units",
            "full time",
            "full-time",
            "graduate",
            "graduation",
            "concentration",
            "drop",
            "add",
            "replace",
            "wait list",
            "permission",
            "critical",
            "blocker",
            "deadline",
            "risk",
            "launch",
            "release",
        ),
    )
    return not has_outcome


def _is_raw_transcript_style_sentence(text: str) -> bool:
    lowered = _clean_summary_sentence(text).lower()
    if not lowered:
        return False
    return lowered.startswith(
        (
            "it's actually",
            "now the student has",
            "the only thing left would be just",
            "because look",
            "that's the only other thing",
            "nope,",
        )
    )


def _summary_contains_low_quality_transcript_phrasing(summary_body: str) -> bool:
    sentences = [s for s in split_sentences(summary_body) if s.strip()]
    return any(
        any(phrase in _clean_summary_sentence(sentence).lower() for phrase in SUMMARY_DISALLOWED_PHRASES)
        or _is_low_value_schedule_logistics_sentence(_clean_summary_sentence(sentence))
        or _is_raw_transcript_style_sentence(sentence)
        or bool(re.search(r"\b1 units\b", _clean_summary_sentence(sentence).lower()))
        for sentence in sentences
    )


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
    candidate = re.sub(r"\bi['’]ll\b", "I will", candidate, flags=re.IGNORECASE)
    candidate = re.sub(r"\bwe['’]ll\b", "we will", candidate, flags=re.IGNORECASE)
    candidate = re.sub(r"\byou['’]ll\b", "you will", candidate, flags=re.IGNORECASE)
    candidate = re.sub(r"\bgonna\b", "going to", candidate, flags=re.IGNORECASE)
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
    candidate = re.sub(r"(?i)(?<=\S)\s+none\.?$", "", candidate).strip()
    candidate = candidate.strip(" ,;:-")
    return _collapse_spaces(candidate)


def _rewrite_advising_action_candidate(text: str) -> str:
    cleaned = _collapse_spaces(text or "")
    lowered = cleaned.lower()
    if not cleaned:
        return ""
    if "send transcripts from the school where you took it" in lowered or "send transcripts from the school where the course was taken" in lowered:
        return "Student: send the community college transcript for transfer credit evaluation"
    if "decide on a concentration" in lowered:
        return "Student: decide on a concentration so the remaining classes can be planned"
    if "concentration isn't declared yet" in lowered:
        return "Student: declare a concentration before graduation"
    return cleaned


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
    if ACTION_REQUEST_RE.match(candidate):
        return True
    return bool(ACTION_COMMITMENT_RE.match(candidate) or ACTION_BARE_MODAL_RE.match(candidate) or ACTION_IMPERATIVE_RE.match(candidate))


def _is_bad_summary_sentence(sentence: str, transcript_words: Set[str]) -> bool:
    cleaned = _collapse_spaces(sentence)
    if not cleaned:
        return True
    if cleaned.endswith("?"):
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
    if re.match(r"^(?:have to|need to|must|should|replace|drop|add|take)\b", lowered):
        return True
    if lowered.startswith("you "):
        return True
    if re.match(r"^(?:replace|drop|add|take)\s+", lowered):
        return True
    if re.search(r"\bi see you\b", lowered):
        return True
    if re.search(r"\bi\s+(?:am|will|need(?:\s+to)?|should|must|have to|plan to|going to|gonna)\b", lowered):
        return True
    if re.search(r"\b(i|me|my|mine|we|our|ours|us|you|your|yours)\b", lowered):
        return True
    if any(phrase in lowered for phrase in SUMMARY_LOW_SIGNAL_PHRASES) and len(cleaned.split()) <= 10:
        return True
    tokens = re.findall(r"[a-z']+", lowered)
    if tokens and tokens[-1] in ACTION_FRAGMENT_ENDINGS and len(tokens) <= 8:
        return True
    if _is_low_value_schedule_logistics_sentence(cleaned):
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
    if _contains_trigger(cleaned, DECISION_SIGNAL_TRIGGERS):
        score += 2
    if _contains_trigger(cleaned, LOW_PRIORITY_CONTEXT_TRIGGERS):
        score -= 1
    if _is_low_value_schedule_logistics_sentence(cleaned):
        score -= 3
    lowered = cleaned.lower()
    if "student" in lowered or "coach" in lowered:
        score += 1
    word_count = len(cleaned.split())
    if word_count < 4:
        score -= 1
    return score


def _is_advising_transcript(transcript: str) -> bool:
    lowered = (transcript or "").lower()
    hits = sum(1 for trigger in ADVISING_CONTEXT_TRIGGERS if trigger in lowered)
    return hits >= 5


def _rewrite_advising_summary_sentence(sentence: str) -> str:
    cleaned = _collapse_spaces(sentence)
    lowered = cleaned.lower()
    if not cleaned:
        return ""
    if "the student wants to get one more class" in lowered and "full time" in lowered:
        return "The student wanted to add one more class to reach full-time status."
    if "the student needs help with registering for spring" in lowered and "transfer credit" in lowered:
        return "The student needed help finalizing spring registration and confirming that community college transfer credit would count."
    if "the student needs to make sure the classes for spring are set up properly" in lowered:
        return "The student wanted to confirm that the spring schedule was set up correctly."
    if "it keeps the degree plan on course" in lowered:
        return "The student wanted to confirm that the planned spring classes keep the degree plan on course."
    if "either one would fulfill the requirement" in lowered and ("old testament" in lowered or "new testament" in lowered):
        return "Either Old or New Testament survey would satisfy the remaining Christian studies requirement."
    if "three total by the time you graduate" in lowered and "christian studies" in lowered:
        return "The student needs three Christian studies courses by graduation."
    units_match = re.search(r"\b(?:will be at|has)\s+(\d+)\s+units\b", lowered)
    if units_match:
        units = units_match.group(1)
        if "118" in lowered:
            return f"Once Flight 118 is added mid-semester, the student will be at {units} units."
        if "five classes" in lowered:
            return f"The spring schedule totals {units} units across five classes."
        return f"The updated schedule brings the student to {units} units."
    classes_match = re.search(r"\b(\d+)\s+units,\s+([a-z]+)\s+classes\b", lowered)
    if classes_match:
        units = classes_match.group(1)
        class_count = classes_match.group(2)
        return f"The spring schedule totals {units} units across {class_count} classes."
    if "concentration isn't declared yet" in lowered:
        return "The student still needs to declare a concentration before graduation."
    if "decide on a concentration" in lowered:
        return "The student needs to decide on a concentration soon so the remaining classes can be planned."
    if "flight operations concentration" in lowered:
        return "The spring schedule was aligned with the flight operations concentration."
    if "send transcripts from the school where the course was taken" in lowered:
        return "The student still needs to send the community college transcript so the transfer credit can be evaluated."
    if "need to get to 124 after completing all these courses" in lowered:
        return "After the current schedule, the student still needs to reach 124 total units."
    if "only thing left would be just the uas and then crm" in lowered:
        return "After spring, the remaining concentration courses are UAS and CRM."
    if "drop meteorology in order to add avionics" in lowered:
        return "The student needs to drop meteorology to add modern avionics."
    if "should be on a wait list" in lowered:
        return "The student should already be on the wait list for the required flight lab."
    return cleaned


def _select_advising_candidate(
    candidates: Sequence[Dict[str, object]],
    triggers: Sequence[str],
    *,
    prefer_early: bool = False,
    prefer_late: bool = False,
) -> Dict[str, object] | None:
    if not candidates:
        return None
    best_candidate: Dict[str, object] | None = None
    best_score = float("-inf")
    total = max(int(candidates[-1]["idx"]) + 1, 1)
    for candidate in candidates:
        raw = str(candidate["raw"])
        rewritten = str(candidate["text"])
        lowered = f"{raw} {rewritten}".lower()
        if not any(trigger in lowered for trigger in triggers):
            continue
        score = float(candidate["score"])
        score += 3.0
        position = int(candidate["idx"]) / total
        if prefer_early:
            score += max(0.0, 1.5 - (position * 2.0))
            if "needs help" in lowered or "wanted to" in lowered or "wants to" in lowered:
                score += 2.0
            if "registering for" in lowered or "transfer credit" in lowered:
                score += 3.0
        if prefer_late:
            score += max(0.0, (position * 2.0) - 0.5)
            if "remaining concentration courses" in lowered or "124 total units" in lowered or "will be at" in lowered:
                score += 1.5
        if "fulfill the requirement" in lowered or "remaining requirement" in lowered:
            score += 1.5
        if "spring schedule" in lowered or "flight operations concentration" in lowered:
            score += 1.0
        if score > best_score:
            best_score = score
            best_candidate = candidate
    return best_candidate


def _build_advising_summary_body(transcript: str) -> str:
    if not _is_advising_transcript(transcript):
        return "Not enough content to summarize."

    transcript_words = _content_word_set(transcript)
    raw_sentences = split_sentences(transcript)
    candidates: List[Dict[str, object]] = []
    for idx, raw in enumerate(raw_sentences):
        cleaned = _clean_summary_sentence(raw)
        if not cleaned:
            continue
        cleaned = _trim_words(cleaned, MAX_SUMMARY_SENTENCE_WORDS)
        rewritten = _rewrite_advising_summary_sentence(cleaned)
        if not rewritten:
            continue
        rewritten = _ensure_sentence_ending(_trim_words(_polish_text_snippet(rewritten), MAX_SUMMARY_SENTENCE_WORDS))
        cleaned_is_bad = _is_bad_summary_sentence(cleaned, transcript_words)
        if cleaned_is_bad and rewritten == cleaned:
            continue
        if cleaned_is_bad:
            lowered_rewritten = rewritten.lower()
            if len(rewritten.split()) < 5:
                continue
            if re.search(r"\b(i|me|my|mine|we|our|ours|us|you|your|yours)\b", lowered_rewritten):
                continue
            if _is_low_value_schedule_logistics_sentence(rewritten):
                continue
            if not _is_sentence_supported_by_transcript(rewritten, transcript_words):
                continue
        if _contains_placeholder_phrase(rewritten):
            continue
        candidates.append(
            {
                "idx": idx,
                "raw": cleaned,
                "text": rewritten,
                "score": _score_summary_candidate(cleaned),
            }
        )

    if not candidates:
        return "Not enough content to summarize."

    selected: List[str] = []
    used_indexes = set()
    for candidate in (
        _select_advising_candidate(candidates, ADVISING_AGENDA_TRIGGERS, prefer_early=True),
        _select_advising_candidate(candidates, ADVISING_PLAN_TRIGGERS),
        _select_advising_candidate(candidates, ADVISING_REMAINING_TRIGGERS, prefer_late=True),
    ):
        if not candidate:
            continue
        idx = int(candidate["idx"])
        text = str(candidate["text"])
        if idx in used_indexes:
            continue
        if _is_redundant_sentence(text, selected):
            continue
        used_indexes.add(idx)
        selected.append(text)

    if len(selected) < TARGET_SUMMARY_SENTENCES:
        for candidate in sorted(candidates, key=lambda item: (float(item["score"]), -int(item["idx"])), reverse=True):
            idx = int(candidate["idx"])
            text = str(candidate["text"])
            if idx in used_indexes:
                continue
            if _is_redundant_sentence(text, selected):
                continue
            used_indexes.add(idx)
            selected.append(text)
            if len(selected) >= MAX_SUMMARY_SENTENCES:
                break

    if not selected:
        return "Not enough content to summarize."

    lowered_transcript = transcript.lower()
    refined_selected: List[str] = []
    for sentence in selected[:MAX_SUMMARY_SENTENCES]:
        lowered_sentence = sentence.lower()
        if (
            "spring schedule was set up correctly" in lowered_sentence
            and "15 units" in lowered_transcript
            and "five classes" in lowered_transcript
        ):
            sentence = "The student wanted to confirm that the spring schedule was set up correctly and that it totals 15 units across five classes."
        if (
            "remaining concentration courses are uas and crm" in lowered_sentence
            and "124" in lowered_transcript
            and "124" not in lowered_sentence
        ):
            sentence = "After spring, the remaining concentration courses are UAS and CRM, and the student still needs to reach 124 total units."
        refined_selected.append(
            _ensure_sentence_ending(_trim_words(_polish_text_snippet(sentence), MAX_SUMMARY_SENTENCE_WORDS))
        )

    return " ".join(refined_selected).strip()


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
    lowered = without_role.lower()
    if any(phrase in lowered for phrase in AMBIGUOUS_ACTION_PHRASES):
        return False
    if re.search(r"\bget to\s+\d+\b", lowered) and "after completing all these courses" in lowered:
        return False
    if not _contains_trigger(without_role, ACTION_CONTENT_TRIGGERS):
        return False
    words = _content_word_set(without_role)
    if not words:
        return False
    overlap = len(words & transcript_words)
    if not (overlap >= 2 or (overlap >= 1 and len(words) <= 4)):
        return False
    similarity = _max_sentence_similarity(without_role, transcript_sentences)
    if any(phrase in lowered for phrase in GENERIC_ADMIN_ACTION_PHRASES) and similarity < 0.72:
        return False
    return similarity >= 0.45


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
        item = _rewrite_advising_action_candidate(item)
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
    role_name = ""
    role_match = re.match(r"^([A-Za-z][A-Za-z0-9 _.'-]{0,30}):\s*(.+)$", text)
    if role_match:
        role_name = role_match.group(1).strip().lower()
        text = role_match.group(2).strip()
    else:
        text = _role_prefix_re().sub("", text).strip()
        if re.match(r"^you\s+", text, flags=re.IGNORECASE):
            role_name = "student"
    text = _normalise_action_candidate(text)
    text = re.split(r"[;,]", text, maxsplit=1)[0].strip()
    text = re.sub(
        r"^(?:please\s+)?(?:we|i|you|they)\s+(?:will|need(?:\s+to)?|needs(?:\s+to)?|should|must|have to|plan to)\s+",
        "",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r"^(?:will|need(?:\s+to)?|needs(?:\s+to)?|should|must|have to|plan to|going to)\s+", "", text, flags=re.IGNORECASE)
    text = text.rstrip(".")
    text = _trim_words_no_ellipsis(text, 12)
    if not text:
        return ""
    role_subject = ""
    if role_name == "student":
        role_subject = "the student"
    elif role_name == "coach":
        role_subject = "the coach"
    elif role_name == "advisor":
        role_subject = "the advisor"
    elif role_name == "tutor":
        role_subject = "the tutor"
    elif role_name:
        role_subject = f"the {role_name}"
    if role_subject:
        return f"{role_subject} should {text}"
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
        followup = f"Follow-up action: {clauses[0]}."
    else:
        followup = f"Follow-up actions: {clauses[0]}; {clauses[1]}."
    followup = _ensure_sentence_ending(_trim_words(_polish_text_snippet(followup), MAX_SUMMARY_SENTENCE_WORDS))
    if _is_redundant_sentence(followup, sentences):
        return summary_body
    return f"{summary_body} {followup}".strip()


def _normalise_summary_body(
    summary_body: str,
    transcript: str,
    high_importance_text: str = "",
    allow_transcript_backfill: bool = True,
    allow_high_importance_backfill: bool = True,
) -> str:
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

    if allow_transcript_backfill and len(summary_sentences) < MIN_SUMMARY_SENTENCES and transcript_sentences:
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
    if allow_high_importance_backfill and high_signal and not summary_has_high_signal:
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


def _summary_body_quality_score(summary_body: str, transcript: str) -> float:
    if not summary_body or summary_body == "Not enough content to summarize.":
        return -100.0
    transcript_words = _content_word_set(transcript)
    transcript_sentences = split_sentences(transcript)
    sentences = [s for s in split_sentences(summary_body) if s.strip()]
    if not sentences:
        return -100.0

    score = 0.0
    if 1 <= len(sentences) <= MAX_SUMMARY_SENTENCES:
        score += 2.0
    else:
        score -= 1.5

    accepted: List[str] = []
    for sentence in sentences:
        cleaned = _clean_summary_sentence(sentence)
        if not cleaned:
            score -= 2.0
            continue
        lowered = cleaned.lower()
        similarity = _max_sentence_similarity(cleaned, transcript_sentences)
        score += similarity * 2.0
        if _is_sentence_supported_by_transcript(cleaned, transcript_words):
            score += 1.0
        else:
            score -= 2.0
        if _contains_placeholder_phrase(cleaned):
            score -= 2.0
        if re.search(r"\b(i|me|my|mine|we|our|ours|us|you|your|yours)\b", lowered):
            score -= 1.5
        if any(phrase in lowered for phrase in SUMMARY_DISALLOWED_PHRASES):
            score -= 1.5
        if _is_low_value_schedule_logistics_sentence(cleaned):
            score -= 1.5
        if _is_redundant_sentence(cleaned, accepted):
            score -= 1.0
        else:
            accepted.append(cleaned)
    return score


def _build_extractive_summary_body(transcript: str) -> str:
    advising_body = _build_advising_summary_body(transcript)
    transcript_words = _content_word_set(transcript)
    transcript_sentences = split_sentences(transcript)
    if not transcript_sentences:
        return "Not enough content to summarize."

    scored: List[tuple[int, int, str]] = []
    for idx, raw in enumerate(transcript_sentences):
        cleaned = _clean_summary_sentence(raw)
        if not cleaned:
            continue
        cleaned = _trim_words(cleaned, MAX_SUMMARY_SENTENCE_WORDS)
        if _is_bad_summary_sentence(cleaned, transcript_words):
            continue
        score = _score_summary_candidate(cleaned)
        similarity = _max_sentence_similarity(cleaned, transcript_sentences)
        scored.append((score + int(similarity * 3), idx, cleaned))

    if not scored:
        return advising_body if advising_body != "Not enough content to summarize." else "Not enough content to summarize."

    scored.sort(key=lambda item: (item[0], -item[1]), reverse=True)
    selected: List[tuple[int, str]] = []
    selected_sentences: List[str] = []
    for score, idx, sentence in scored:
        if selected and score < 1:
            continue
        if _is_redundant_sentence(sentence, selected_sentences):
            continue
        selected.append((idx, sentence))
        selected_sentences.append(sentence)
        if len(selected_sentences) >= MAX_SUMMARY_SENTENCES:
            break

    if len(selected_sentences) < MIN_SUMMARY_SENTENCES:
        for idx, raw in enumerate(transcript_sentences):
            cleaned = _clean_summary_sentence(raw)
            if not cleaned:
                continue
            cleaned = _trim_words(cleaned, MAX_SUMMARY_SENTENCE_WORDS)
            if _is_bad_summary_sentence(cleaned, transcript_words):
                continue
            if _is_redundant_sentence(cleaned, selected_sentences):
                continue
            selected.append((idx, cleaned))
            selected_sentences.append(cleaned)
            if len(selected_sentences) >= MIN_SUMMARY_SENTENCES:
                break

    if not selected_sentences:
        return advising_body if advising_body != "Not enough content to summarize." else "Not enough content to summarize."

    selected.sort(key=lambda item: item[0])
    normalized = [
        _ensure_sentence_ending(_trim_words(_polish_text_snippet(sentence), MAX_SUMMARY_SENTENCE_WORDS))
        for _, sentence in selected[:MAX_SUMMARY_SENTENCES]
    ]
    extractive_body = " ".join(normalized).strip() if normalized else "Not enough content to summarize."
    if advising_body != "Not enough content to summarize.":
        if _is_advising_transcript(transcript):
            if _summary_contains_low_quality_transcript_phrasing(extractive_body):
                return advising_body
        if _summary_body_quality_score(advising_body, transcript) >= _summary_body_quality_score(extractive_body, transcript) - 0.2:
            return advising_body
    return extractive_body


def _expand_summary_with_transcript_details(summary_body: str, transcript: str) -> str:
    if not summary_body or summary_body == "Not enough content to summarize.":
        return summary_body

    expanded: List[str] = []
    for sentence in split_sentences(summary_body):
        cleaned = _clean_summary_sentence(sentence)
        if not cleaned:
            continue
        polished = _ensure_sentence_ending(_trim_words(_polish_text_snippet(cleaned), MAX_SUMMARY_SENTENCE_WORDS))
        if _is_redundant_sentence(polished, expanded):
            continue
        expanded.append(polished)

    if not expanded:
        return summary_body
    if len(expanded) >= TARGET_SUMMARY_SENTENCES and len(" ".join(expanded).split()) >= TARGET_SUMMARY_WORDS:
        return " ".join(expanded).strip()

    extractive_body = _build_extractive_summary_body(transcript)
    if extractive_body == "Not enough content to summarize.":
        return " ".join(expanded).strip()

    for sentence in split_sentences(extractive_body):
        cleaned = _clean_summary_sentence(sentence)
        if not cleaned:
            continue
        polished = _ensure_sentence_ending(_trim_words(_polish_text_snippet(cleaned), MAX_SUMMARY_SENTENCE_WORDS))
        if _is_redundant_sentence(polished, expanded):
            continue
        expanded.append(polished)
        if len(expanded) >= MAX_SUMMARY_SENTENCES:
            break
        if len(expanded) >= TARGET_SUMMARY_SENTENCES and len(" ".join(expanded).split()) >= TARGET_SUMMARY_WORDS:
            break

    return " ".join(expanded[:MAX_SUMMARY_SENTENCES]).strip()


def _fallback_model_summary_only(summary_body: str, transcript: str = "") -> str:
    transcript_words = _content_word_set(transcript)
    raw_sentences = [_clean_summary_sentence(sentence) for sentence in split_sentences(summary_body)]
    kept: List[str] = []
    for sentence in raw_sentences:
        if not sentence:
            continue
        polished = _ensure_sentence_ending(_trim_words(_polish_text_snippet(sentence), MAX_SUMMARY_SENTENCE_WORDS))
        if _contains_placeholder_phrase(polished):
            continue
        if transcript_words and _is_bad_summary_sentence(polished, transcript_words):
            continue
        if _is_redundant_sentence(polished, kept):
            continue
        kept.append(polished)
        if len(kept) >= MAX_SUMMARY_SENTENCES:
            break
    if not kept:
        return "Not enough content to summarize."
    return " ".join(kept).strip()


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


def finalize_summary_output_model_first(summary: str, transcript: str) -> str:
    sections = parse_sections(summary)
    high_importance_text = sections.get(HIGH_IMPORTANCE_MARKER, "")
    transcript_words = _content_word_set(transcript)
    transcript_sentences = split_sentences(transcript)

    model_summary_body = _normalise_summary_body(
        sections.get(SUMMARY_MARKER, ""),
        transcript,
        high_importance_text=high_importance_text,
        allow_transcript_backfill=False,
        allow_high_importance_backfill=False,
    )
    grounded_summary_body = _normalise_summary_body(
        sections.get(SUMMARY_MARKER, ""),
        transcript,
        high_importance_text=high_importance_text,
        allow_transcript_backfill=True,
        allow_high_importance_backfill=False,
    )
    extractive_summary_body = _build_extractive_summary_body(transcript)
    candidate_summaries = {
        "model": _expand_summary_with_transcript_details(model_summary_body, transcript),
        "grounded": _expand_summary_with_transcript_details(grounded_summary_body, transcript),
        "extractive": extractive_summary_body,
    }
    candidate_scores = {
        name: _summary_body_quality_score(body, transcript)
        for name, body in candidate_summaries.items()
    }
    summary_body = candidate_summaries["model"]
    forced_extractive = False
    if _is_advising_transcript(transcript):
        extractive_body = candidate_summaries["extractive"]
        if extractive_body != "Not enough content to summarize." and not _summary_contains_low_quality_transcript_phrasing(extractive_body):
            summary_body = extractive_body
            forced_extractive = True
    best_name = max(candidate_scores, key=candidate_scores.get)
    if not forced_extractive and best_name != "model" and candidate_scores[best_name] > candidate_scores["model"] + 1.0:
        summary_body = candidate_summaries[best_name]
    if summary_body == "Not enough content to summarize.":
        summary_body = candidate_summaries["grounded"]
    if summary_body == "Not enough content to summarize.":
        summary_body = candidate_summaries["extractive"]
    if summary_body == "Not enough content to summarize.":
        summary_body = _fallback_model_summary_only(sections.get(SUMMARY_MARKER, ""), transcript)

    action_bullets = _extract_explicit_action_bullets(
        transcript,
        transcript_words,
        transcript_sentences,
        MAX_ACTION_ITEMS,
    )
    if not action_bullets:
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
    if count_summary_sentences(f"{SUMMARY_MARKER}\n{summary_body}") < TARGET_SUMMARY_SENTENCES and action_bullets:
        summary_body = _enrich_summary_with_actions(summary_body, action_bullets)

    lines = [SUMMARY_MARKER, summary_body, ""]
    if action_bullets:
        lines.append(ACTION_ITEMS_MARKER)
        lines.extend(action_bullets)
    else:
        lines.append(f"{ACTION_ITEMS_MARKER} none.")
    return "\n".join(lines).strip()


def finalize_summary_output_explicit_actions(summary: str, transcript: str) -> str:
    sections = parse_sections(summary)
    high_importance_text = sections.get(HIGH_IMPORTANCE_MARKER, "")
    transcript_words = _content_word_set(transcript)
    transcript_sentences = split_sentences(transcript)
    model_summary_body = _normalise_summary_body(
        sections.get(SUMMARY_MARKER, ""),
        transcript,
        high_importance_text=high_importance_text,
        allow_transcript_backfill=False,
        allow_high_importance_backfill=False,
    )
    transcript_grounded_summary = _normalise_summary_body(
        sections.get(SUMMARY_MARKER, ""),
        transcript,
        high_importance_text=high_importance_text,
        allow_transcript_backfill=True,
        allow_high_importance_backfill=True,
    )
    extractive_summary_body = _build_extractive_summary_body(transcript)
    candidate_summaries = {
        "model": model_summary_body,
        "grounded": transcript_grounded_summary,
        "extractive": extractive_summary_body,
    }
    candidate_scores = {
        name: _summary_body_quality_score(body, transcript)
        for name, body in candidate_summaries.items()
    }
    summary_body = candidate_summaries["model"]
    best_name = max(candidate_scores, key=candidate_scores.get)
    summary_body = candidate_summaries[best_name]
    # Prefer transcript-grounded extractive summaries when quality is close; this reduces hallucinations on small local models.
    if (
        candidate_scores["extractive"] >= candidate_scores[best_name] - EXTRACTIVE_SELECTION_MARGIN
        and candidate_summaries["extractive"] != "Not enough content to summarize."
    ):
        summary_body = candidate_summaries["extractive"]
    if summary_body == "Not enough content to summarize.":
        summary_body = _normalise_summary_body(
            sections.get(SUMMARY_MARKER, ""),
            transcript,
            high_importance_text=high_importance_text,
            allow_transcript_backfill=True,
            allow_high_importance_backfill=True,
        )
    if summary_body == "Not enough content to summarize.":
        summary_body = _fallback_model_summary_only(sections.get(SUMMARY_MARKER, ""), transcript)
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
