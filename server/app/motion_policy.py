"""Deterministic motion defaults so bare animate never lands on robotic wander."""
from __future__ import annotations

import re

from .schema import Intent

_WANDER_WORDS = re.compile(
    r"\b(?:wander|roam|explore|freely|free\s+movement|move\s+around|prowl)\b",
    re.I,
)


def soften_default_motion(text: str, intent: Intent) -> Intent:
    """Remap unsolicited wander on bare animate to a smooth float."""
    if intent.action != "animate":
        return intent
    if intent.track_keyframes:
        return intent
    motion = (intent.motion or intent.preset or "").lower()
    if motion != "wander":
        return intent
    if _WANDER_WORDS.search(text):
        return intent
    params = dict(intent.motion_params or {})
    params.setdefault("amplitude", 0.45)
    params.setdefault("frequency", 1.4)
    return intent.model_copy(
        update={
            "motion": "float",
            "preset": None,
            "motion_params": params,
            "animate_repeat": True if intent.animate_repeat is None else intent.animate_repeat,
        }
    )
