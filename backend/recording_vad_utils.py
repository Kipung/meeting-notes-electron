import math
from typing import Sequence, TypeVar


T = TypeVar("T")


def positive_int_from_env(raw: str | None, default: int) -> int:
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def frames_for_ms(duration_ms: int, chunk_ms: float) -> int:
    if duration_ms <= 0:
        return 0
    if chunk_ms <= 0:
        return 1
    return max(1, int(math.ceil(duration_ms / chunk_ms)))


def samples_for_ms(duration_ms: int, sample_rate: int) -> int:
    if duration_ms <= 0 or sample_rate <= 0:
        return 0
    return max(1, int((duration_ms / 1000.0) * sample_rate))


def take_post_pad_frames(frames: Sequence[T], max_frames: int) -> list[T]:
    if max_frames <= 0 or not frames:
        return []
    return list(frames[:max_frames])


def utterance_sample_count(frames: Sequence[object]) -> int:
    total = 0
    for frame in frames:
        total += int(getattr(frame, "size", len(frame)))  # type: ignore[arg-type]
    return total


def should_force_flush_utterance(frames: Sequence[object], max_utterance_samples: int) -> bool:
    return max_utterance_samples > 0 and utterance_sample_count(frames) >= max_utterance_samples
