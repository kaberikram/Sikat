"""Clause ownership: grammar vs LLM.

**Grammar-owned** (instant, final): spawn, transform, remove, material, lights,
fx, camera, playback, complete assign, and an explicit default/stock showcase.
Literal bounce/orbit/spin stay grammar instruments.

**LLM-owned**: unparsed clauses, clarify, animate, creative/mood/shine/surprise
speech, or incomplete grammar reads (describe, partial animate). Catalogs are
the keyless fallback only.
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

_TRUST_OR_SURPRISE = re.compile(
    r"\b("
    r"surprise me|blow my mind|impress me|"
    r"i trust you|trust you|your call|do your thing|"
    r"go off|go crazy|goes crazy|go nuts|go wild|"
    r"make it insane|make it wild"
    r")\b",
    re.I,
)

_MOOD_VIBE = re.compile(
    r"\b("
    r"neon|noir|tokyo|cyberpunk|vibe|atmosphere|"
    r"golden hour|moody|cinematic"
    r")\b",
    re.I,
)

_STOCK_SHOWCASE = re.compile(
    r"\b(?:default|stock)\s+(?:showcase|shine|hero\s+shot|product\s+(?:shot|showcase))\b|"
    r"\b(?:showcase|shine|hero\s+shot)\s+(?:default|stock)\b",
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
    # Mood / shine / showcase is authored by the planner when keyed.
    # Stock look is grammar-owned only for an explicit default/stock ask.
    if intent.action == "set_scene" and intent.mood:
        return not is_stock_showcase(clause)
    if _CREATIVE_LANGUAGE.search(clause.lower()):
        return True
    if _TRUST_OR_SURPRISE.search(clause.lower()) or _MOOD_VIBE.search(clause.lower()):
        return True
    if not _grammar_has_complete_intent(intent):
        return True
    return False


def is_llm_owned_clause(
    clause: str, intent: Intent | None, *, llm_available: bool = False
) -> bool:
    """Alias for defer_clause_to_llm — True when the LLM owns the clause."""
    return defer_clause_to_llm(clause, intent, llm_available=llm_available)


_LITERAL_MOTION = re.compile(
    r"\b(bounce|spin|orbit|drop|float|rise|sway|wander)\b",
    re.I,
)


def said_literal_motion(text: str) -> bool:
    """True when the director named a craft synth (bounce/spin/orbit/…)."""
    return bool(_LITERAL_MOTION.search(text))


def catalog_motion_forbidden(text: str) -> bool:
    """Open briefs must author keyframes — a motion id is not a take."""
    if said_literal_motion(text):
        return False
    return is_open_direction(text)


_OBJECT_VERB = re.compile(
    r"\b(box|sphere|cone|cylinder|torus|plane|object|camera|light|bloom|"
    r"the\s+\w+|move|spawn|add|enable|disable|set|rotate|scale|play|pause|cut|record)\b",
    re.I,
)


def is_stock_showcase(text: str) -> bool:
    """True only for an explicit default/stock showcase ask — catalog allowed."""
    return bool(_STOCK_SHOWCASE.search(text))


def is_open_direction(text: str) -> bool:
    """Feeling, story, surprise, or vibe without a concrete object+verb."""
    lower = text.lower().strip()
    if is_stock_showcase(lower):
        return False
    if _TRUST_OR_SURPRISE.search(lower):
        return True
    if _OBJECT_VERB.search(lower):
        return False
    return bool(_CREATIVE_LANGUAGE.search(lower) or _MOOD_VIBE.search(lower))
