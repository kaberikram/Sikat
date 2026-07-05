"""When to defer a clause to the LLM instead of instant rule grammar.

Phase F: grammar can **coarse-emit** while LLM refines in parallel — deferral
now means "wait for LLM only" (no coarse path), not "block all emits".
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
    """True when grammar gives enough to start work before LLM finishes."""
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


def needs_llm_refinement(
    clause: str, intent: Intent | None, *, llm_available: bool = False
) -> bool:
    """True when LLM should still run after a coarse emit (or alone)."""
    if not llm_available:
        return False
    if intent is None:
        return True
    if intent.action == "animate":
        return True
    if _CREATIVE_LANGUAGE.search(clause.lower()):
        return True
    return False


def defer_clause_to_llm(
    clause: str, intent: Intent | None, *, llm_available: bool = False
) -> bool:
    """True → skip instant grammar emit; wait for LLM only (no coarse path)."""
    if intent is None:
        return True
    if not llm_available:
        return False
    if should_coarse_emit(intent):
        return False
    if _CREATIVE_LANGUAGE.search(clause.lower()) and intent.action != "animate":
        return True
    if llm_available and intent.action == "animate":
        return True
    return False
