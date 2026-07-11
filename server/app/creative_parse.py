"""Clause ownership: grammar vs LLM.

**Grammar-owned** (instant, final): spawn, transform, remove, material, lights,
fx, camera, playback, mood, complete assign — any clause with a complete
deterministic parse.

**LLM-owned**: unparsed clauses, clarify, animate, creative language, or
incomplete grammar reads (describe, partial animate).
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


def _grammar_has_complete_intent(intent: Intent) -> bool:
    """True when grammar gives enough to emit without the LLM."""
    if intent.action == "animate":
        motion = intent.motion or intent.preset
        target = intent.target
        if intent.addressee and not target:
            return True
        return bool(target and motion)
    if intent.action == "describe":
        return False
    if intent.action == "assign":
        return bool(intent.addressee and intent.target)
    return True


def defer_clause_to_llm(
    clause: str, intent: Intent | None, *, llm_available: bool = False
) -> bool:
    """True → LLM-owned; grammar must not emit this clause."""
    if intent is None:
        return True
    if not llm_available:
        return False
    if intent.action == "clarify":
        return True
    # Open-speech converse (hello/thanks) — grammar radio is final; don't wait on LLM.
    if intent.action == "describe":
        from .converse import is_open_speech

        if is_open_speech(clause):
            return False
    if intent.action == "animate":
        return True
    # Shine/showcase is a creative beat: the LLM choreographs a unique take
    # when configured; the deterministic macro is the keyless fallback only.
    if intent.action == "set_scene" and intent.mood == "shine":
        return True
    if _CREATIVE_LANGUAGE.search(clause.lower()):
        return True
    if not _grammar_has_complete_intent(intent):
        return True
    return False


def is_llm_owned_clause(
    clause: str, intent: Intent | None, *, llm_available: bool = False
) -> bool:
    """Alias for defer_clause_to_llm — True when the LLM owns the clause."""
    return defer_clause_to_llm(clause, intent, llm_available=llm_available)


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
