"""Rolling conversation memory for Director Mode — per-connection when bound."""
from __future__ import annotations

import random
import time
from collections import deque
from contextvars import ContextVar, Token
from dataclasses import dataclass, field

from .schema import Intent

_MAX = 8
CLARIFY_TIMEOUT_SEC = 20.0
_RECENT_NOTES_MAX = 12


@dataclass
class Exchange:
    text: str
    intent_summaries: list[str] = field(default_factory=list)
    targets: list[str] = field(default_factory=list)


@dataclass
class PendingClarify:
    command_id: str
    held_clauses: list[str]
    question: str
    options: list[str]
    agent: str
    created_at: float = field(default_factory=time.monotonic)


def _summarize(intent: Intent) -> str:
    parts = [intent.action]
    if intent.target:
        parts.append(intent.target)
    if intent.preset:
        parts.append(intent.preset)
    if intent.mood:
        parts.append(intent.mood)
    return " ".join(parts)


class SessionContext:
    def __init__(self) -> None:
        self._history: deque[Exchange] = deque(maxlen=_MAX)
        self._pending_target: str | None = None
        self._pending_addressee: int | None = None
        self._last_transform: Intent | None = None
        self._pending_clarify: PendingClarify | None = None
        self._clarify_target: str | None = None
        self.recent_notes: deque[str] = deque(maxlen=_RECENT_NOTES_MAX)

    def note_addressee(self, addressee: int | None) -> None:
        if addressee is not None:
            self._pending_addressee = addressee

    def pending_addressee(self) -> int | None:
        return self._pending_addressee

    def note_target(self, target: str | None) -> None:
        if target:
            self._pending_target = target

    def note_transform(self, intent: Intent) -> None:
        if intent.action == "transform":
            self._last_transform = intent

    def record(self, text: str, intents: list[Intent]) -> None:
        summaries = [_summarize(i) for i in intents]
        targets = [i.target for i in intents if i.target]
        self._history.append(Exchange(text=text, intent_summaries=summaries, targets=targets))
        for intent in intents:
            self.note_transform(intent)
        self._pending_target = None
        self._pending_addressee = None

    def history(self) -> list[Exchange]:
        return list(self._history)

    def last_target(self) -> str | None:
        if self._pending_target:
            return self._pending_target
        for exchange in reversed(self._history):
            if exchange.targets:
                return exchange.targets[-1]
        return None

    def last_transform(self) -> Intent | None:
        return self._last_transform

    def set_pending_clarify(self, pending: PendingClarify) -> None:
        self._pending_clarify = pending

    def pending_clarify(self) -> PendingClarify | None:
        return self._pending_clarify

    def clear_pending_clarify(self) -> None:
        self._pending_clarify = None

    def set_clarify_target(self, target: str | None) -> None:
        self._clarify_target = target

    def consume_clarify_target(self) -> str | None:
        target = self._clarify_target
        self._clarify_target = None
        return target

    def note_say(self, text: str) -> None:
        cleaned = text.strip()
        if cleaned and cleaned not in self.recent_notes:
            self.recent_notes.append(cleaned)

    def pick_fresh_note(self, pool: list[str]) -> str:
        fresh = [n for n in pool if n not in self.recent_notes]
        choice = random.choice(fresh if fresh else pool)
        self.note_say(choice)
        return choice

    def clear(self) -> None:
        self._history.clear()
        self._pending_target = None
        self._pending_addressee = None
        self._last_transform = None
        self._pending_clarify = None
        self._clarify_target = None
        self.recent_notes.clear()


_default = SessionContext()
_session_var: ContextVar[SessionContext] = ContextVar("director_session", default=_default)


def get_session() -> SessionContext:
    return _session_var.get()


def bind_session(ctx: SessionContext) -> Token:
    return _session_var.set(ctx)


def reset_session(token: Token) -> None:
    _session_var.reset(token)


def note_addressee(addressee: int | None) -> None:
    get_session().note_addressee(addressee)


def pending_addressee() -> int | None:
    return get_session().pending_addressee()


def note_target(target: str | None) -> None:
    get_session().note_target(target)


def note_transform(intent: Intent) -> None:
    get_session().note_transform(intent)


def record(text: str, intents: list[Intent]) -> None:
    get_session().record(text, intents)


def history() -> list[Exchange]:
    return get_session().history()


def last_target() -> str | None:
    return get_session().last_target()


def last_transform() -> Intent | None:
    return get_session().last_transform()


def set_pending_clarify(pending: PendingClarify) -> None:
    get_session().set_pending_clarify(pending)


def pending_clarify() -> PendingClarify | None:
    return get_session().pending_clarify()


def clear_pending_clarify() -> None:
    get_session().clear_pending_clarify()


def set_clarify_target(target: str | None) -> None:
    get_session().set_clarify_target(target)


def consume_clarify_target() -> str | None:
    return get_session().consume_clarify_target()


def note_say(text: str) -> None:
    get_session().note_say(text)


def pick_fresh_note(pool: list[str]) -> str:
    return get_session().pick_fresh_note(pool)


def clear() -> None:
    _default.clear()
