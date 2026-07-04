"""When to defer a clause to the LLM instead of instant rule grammar.

When an LLM is configured, **all animate** clauses defer — the model picks motion
params or custom keyframes so even \"bounce the ball\" varies each take.

Without an LLM, grammar runs instantly and `motion_variation` seeds each cue.
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
    r"freely|freeform|freestyle"
    r")\b",
    re.I,
)


def defer_clause_to_llm(
    clause: str, intent: Intent | None, *, llm_available: bool = False
) -> bool:
    """True → skip instant grammar for this clause; wait for LLM."""
    if intent is None:
        return False

    if llm_available and intent.action == "animate":
        return True

    if _CREATIVE_LANGUAGE.search(clause.lower()):
        return True

    return False
