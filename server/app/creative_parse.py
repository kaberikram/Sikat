"""When to defer a clause to the LLM instead of instant rule grammar.

Grammar can **coarse-emit** while the LLM reconciles in parallel — deferral
means "wait for LLM only" (no coarse path), not "block all emits".
"""
from __future__ import annotations

import re

from .schema import Intent

_CREATIVE_LANGUAGE = re.compile(
    r"\b("
    r"like|as if|kind of|sort of|feels?|feeling|"
    r"story|narrative|surprise|surprising|random|weird|unique|creative|"
    r"freestyle|improv|playful|nervous|anxious|lazy|tired|excited|"
    r"dramatic|organic|natural|alive|personality|character|emotion|"
    r"across the stage|over there|under the|around the room|"
    r"explore|journey|tour|visit|meander|snake|curl|swoop|"
    r"dance|dancing|choreograph|perform|acting|"
    r"freely|freeform|freestyle|"
    r"seamless|ping[- ]?pong"
    r")\b",
    re.I,
)


def should_coarse_emit(intent: Intent | None) -> bool:
    """True when grammar gives enough to stage instantly before LLM finishes."""
    if intent is None:
        return False
    if intent.action == "animate":
        motion = intent.motion or intent.preset
        target = intent.target
        if intent.addressee and not target:
            return True
        return bool(target and motion)
    if intent.action in ("describe", "assign"):
        return False
    return True


def defer_clause_to_llm(
    clause: str, intent: Intent | None, *, llm_available: bool = False
) -> bool:
    """True → skip instant grammar emit; wait for LLM only (no coarse path)."""
    if intent is None:
        return True
    if not llm_available:
        return False
    if intent.action == "clarify":
        return True
    if intent.action == "animate":
        return True
    if _CREATIVE_LANGUAGE.search(clause.lower()):
        return True
    if not should_coarse_emit(intent):
        return True
    return False


_OBJECT_VERB = re.compile(
    r"\b(box|sphere|cone|cylinder|torus|plane|object|camera|light|bloom|"
    r"the\s+\w+|move|spawn|add|enable|disable|set|rotate|scale|play|pause|cut|record)\b",
    re.I,
)


def is_open_direction(text: str) -> bool:
    """Mood / vibe language without a concrete object+verb — triggers plan loop."""
    lower = text.lower().strip()
    if not _CREATIVE_LANGUAGE.search(lower):
        return False
    if _OBJECT_VERB.search(lower):
        return False
    return True
