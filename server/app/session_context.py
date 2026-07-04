"""Rolling conversation memory for Director Mode.

Same module pattern as ``scene_state.py``: a process-global that the Producer
writes after every parse and the parsers read while resolving the next command.
It gives Director Mode a short attention span so follow-up direction works like
talking to a person on set — "move the ball up" then "go back a bit" resolves
the second command against the first's target.

Two horizons are tracked:
- ``_history``: a bounded window of committed exchanges, surfaced to the LLM
  prompt and scanned by ``last_target`` / ``last_transform``.
- ``_pending_*``: targets/transforms noted mid-command (across clauses of a
  single instruction) before the exchange is committed by ``record``.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

from .schema import Intent

_MAX = 8


@dataclass
class Exchange:
    text: str
    intent_summaries: list[str] = field(default_factory=list)
    targets: list[str] = field(default_factory=list)


_history: deque[Exchange] = deque(maxlen=_MAX)
# Target/transform seen earlier in the command currently being parsed, so a
# later clause ("...then go back a bit") can resolve before the whole command
# is committed to history.
_pending_target: str | None = None
_last_transform: Intent | None = None


def _summarize(intent: Intent) -> str:
    parts = [intent.action]
    if intent.target:
        parts.append(intent.target)
    if intent.preset:
        parts.append(intent.preset)
    if intent.mood:
        parts.append(intent.mood)
    return " ".join(parts)


def note_target(target: str | None) -> None:
    """Remember a target mid-command (called per parsed clause)."""
    global _pending_target
    if target:
        _pending_target = target


def note_transform(intent: Intent) -> None:
    """Remember the most recent transform so bare 'again' can repeat it."""
    global _last_transform
    if intent.action == "transform":
        _last_transform = intent


def record(text: str, intents: list[Intent]) -> None:
    """Commit a finished exchange, clearing the mid-command pending target."""
    global _pending_target
    summaries = [_summarize(i) for i in intents]
    targets = [i.target for i in intents if i.target]
    _history.append(Exchange(text=text, intent_summaries=summaries, targets=targets))
    for intent in intents:
        note_transform(intent)
    _pending_target = None


def history() -> list[Exchange]:
    return list(_history)


def last_target() -> str | None:
    """Most recent target: mid-command pending first, then committed history."""
    if _pending_target:
        return _pending_target
    for exchange in reversed(_history):
        if exchange.targets:
            return exchange.targets[-1]
    return None


def last_transform() -> Intent | None:
    return _last_transform


def clear() -> None:
    global _pending_target, _last_transform
    _history.clear()
    _pending_target = None
    _last_transform = None
