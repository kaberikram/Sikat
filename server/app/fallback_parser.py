"""Deterministic rule-based text -> Intent parser.

This is the no-API-key path for Director Mode and the safety net whenever the
LLM parse fails or returns invalid JSON. The grammar is documented in
docs/DirectorAI/05_Knowledge_Base/Fallback_Grammar.md — keep both in sync.
"""
from __future__ import annotations

import re

from . import session_context
from .clause_handlers import parse_clause
from .schema import Intent, SceneState

_CLAUSE_SPLIT = re.compile(r"\s*(?:;|\.\s+|,?\s+(?:and\s+)?then\s+)\s*")


def parse(text: str, scene: SceneState | None = None) -> list[Intent]:
    intents: list[Intent] = []
    for clause in _CLAUSE_SPLIT.split(text):
        intent = parse_clause(clause, scene)
        if intent is not None:
            intents.append(intent)
            # Thread the resolved target across clauses so a later clause in the
            # same command ("...then go back a bit") can resolve a pronoun or
            # amendment before the whole exchange is committed to history.
            session_context.note_target(intent.target)
            session_context.note_transform(intent)
    return intents
