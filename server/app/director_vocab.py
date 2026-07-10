"""Colloquial director speak → grammar triggers (instant path, no LLM).

Applied before clause handlers so phrases like "close-up on the ball" or
"reveal a red sphere" hit the rule parser immediately.
"""
from __future__ import annotations

import re

# (pattern, replacement) — applied in order.
_PHRASE_SUBS: list[tuple[re.Pattern[str], str]] = [
    # Camera shorthand
    # "hero shot"/"product shot" are left alone here — they're product-showcase
    # language (see MOOD_WORDS in clause_handlers.py), not a camera zoom.
    (re.compile(r"\b(close[- ]up|tight(?:er)? shot)\b"), "zoom in"),
    (re.compile(r"\b(wide(?:r)? shot|wide angle|establishing shot)\b"), "zoom out"),
    (re.compile(r"\bframe (?:the |a )?"), "camera look at the "),
    (re.compile(r"\bpoint (?:the )?camera at (?:the )?"), "camera look at the "),
    # Spawn shorthand
    (re.compile(r"\bpop in (?:a |an |the |some )?"), "add "),
    (re.compile(r"\breveal(?:ing)? (?:a |an |the |some )?"), "add "),
    (re.compile(r"\bintroduce (?:a |an |the |some )?"), "add "),
    (re.compile(r"\bput (?:a |an |the |some )"), "add a "),
    (re.compile(r"\bthrow in (?:a |an |the |some )?"), "add "),
    (re.compile(r"\bnew (box|sphere|ball|cone|text|tag)\b"), r"add \1"),
    # Text / type
    (re.compile(r"\b(?:write|type|title|headline|caption)\s+"), "add text saying "),
    (re.compile(r"\blabel (?:that )?says\s+"), 'add text saying "'),
    # Animate colloquial
    (re.compile(r"\bmake (?:it|that|the \w+) bounce\b"), "bounce it"),
    (re.compile(r"\bmake (?:it|that|the \w+) float\b"), "float it"),
    (re.compile(r"\bmake (?:it|that|the \w+) drop\b"), "drop it"),
    (re.compile(r"\bmake (?:it|that|the \w+) spin\b"), "spin it"),
    (re.compile(r"\bmove (.+?) freely\b"), r"wander \1"),
    (re.compile(r"\blet (.+?) roam\b"), r"wander \1"),
    (re.compile(r"\bmove (.+?) around\b"), r"wander \1"),
    (re.compile(r"\blet(?:'s| us) bounce\b"), "bounce"),
    (re.compile(r"\bstart bouncing\b"), "bounce"),
    # Remove shorthand
    (re.compile(r"\b(get rid of|take away|clear|lose)\b"), "remove"),
    (re.compile(r"\bhide (?:the )?"), "remove the "),
    # Lights shorthand
    (re.compile(r"\bspotlight\b"), "brighten the lights"),
    (re.compile(r"\bsoft(?:er)? light(?:ing)?\b"), "dim the lights warm"),
    (re.compile(r"\bharsh light(?:ing)?\b"), "brighten the lights"),
    (re.compile(r"\bdramatic light(?:ing)?\b"), "dim the lights"),
    # Playback set slang
    (re.compile(r"\bthat'?s a wrap\b"), "cut"),
    (re.compile(r"\bwrap(?: it)?(?: up)?\b"), "cut"),
    (re.compile(r"\bcontinue\b"), "play"),
    (re.compile(r"\bresume\b"), "play"),
    (re.compile(r"\bmake the (\w+) (huge|tiny|bigger|smaller|massive|minimize)\b"), r"scale the \1 \2"),
    (re.compile(r"\benlarge\b"), "bigger"),
    (re.compile(r"\bexpand\b"), "bigger"),
    (re.compile(r"\bminimize\b"), "smaller"),
    (re.compile(r"\btiny\b"), "smaller"),
    (re.compile(r"\bhuge\b"), "bigger"),
    (re.compile(r"\bmassive\b"), "bigger"),
    # Squash slang
    (re.compile(r"\b(crush|crushing|pressed|press down)\b"), "squash"),
    # Material slang
    (re.compile(r"\bchrome\b"), "silver"),
    (re.compile(r"\bmetallic\b"), "silver"),
    (re.compile(r"\bshiny\b"), "glowing"),
]


def normalize_clause(clause: str) -> str:
    """Expand director colloquialisms into phrases the rule grammar already knows."""
    text = clause.strip().lower()
    if not text:
        return text
    for pattern, repl in _PHRASE_SUBS:
        text = pattern.sub(repl, text)
    return text
