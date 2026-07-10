"""Deterministic rule-based text -> Intent parser.

This is the no-API-key path for Director Mode and the safety net whenever the
LLM parse fails or returns invalid JSON. The grammar is documented in
docs/DirectorAI/05_Knowledge_Base/Fallback_Grammar.md — keep both in sync.
"""
from __future__ import annotations

import re

from . import session_context
from .director_vocab import normalize_clause
from .clause_handlers import parse_clause
from .schema import Intent, SceneState

_CLAUSE_SPLIT = re.compile(
    r"\s*(?:;|\.\s+|,?\s+(?:and\s+)?then\s+)\s*"
    r"|\s*,\s*"
    r"|\s+and\s+(?=(?:make|move|have|let|give|add|spawn|animate|set|rotate|scale|"
    r"spin|bounce|wander|drift|float|orbit|enable|disable|dim|turn|play|pause)\b)",
    re.I,
)

# "Agent 1, you're on the sphere" — comma is address punctuation, not a clause break.
_ADDRESS_COMMA = re.compile(
    r"\b((?:agent|performer|number)\s+(?:one|two|three|four|\d+))\s*,\s*",
    re.I,
)

# "add a red box and a blue sphere" → give the second noun phrase its own add verb.
_CHAINED_SPAWN = re.compile(r"\band\s+(?=a\s+)", re.I)


def split_clauses(text: str) -> list[str]:
    """Split compound director lines on commas, ``then``, ``;``, and bare ``and`` before verbs."""
    protected = _ADDRESS_COMMA.sub(r"\1 ", text)
    chained = _CHAINED_SPAWN.sub(", add ", protected)
    return [clause.strip() for clause in _CLAUSE_SPLIT.split(chained) if clause.strip()]


def parse_one_clause(clause: str, scene: SceneState | None = None) -> Intent | None:
    """Parse a single clause and thread session context for follow-ups."""
    intent = parse_clause(normalize_clause(clause), scene)
    if intent is not None:
        session_context.note_target(intent.target)
        session_context.note_transform(intent)
    return intent


def parse(text: str, scene: SceneState | None = None) -> list[Intent]:
    intents: list[Intent] = []
    for clause in split_clauses(text):
        intent = parse_one_clause(clause, scene)
        if intent is not None:
            intents.append(intent)
    return intents
