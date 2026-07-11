"""Rolling conversation memory for Director Mode — per-connection when bound."""
from __future__ import annotations

import asyncio
import random
import time
from collections import deque
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from .suggestion_gate import SuggestionGate, GateConfig

if TYPE_CHECKING:
    from .schema import CommandPacket, Intent, SceneState

_MAX = 8
CLARIFY_TIMEOUT_SEC = 20.0
_RECENT_NOTES_MAX = 12


@dataclass
class Exchange:
    text: str
    intent_summaries: list[str] = field(default_factory=list)
    targets: list[str] = field(default_factory=list)


@dataclass
class PendingPlan:
    command_id: str
    remaining_beats: list[str]
    completed_beats: list[str]
    plan_text: str
    created_at: float = field(default_factory=time.monotonic)


@dataclass
class PendingClarify:
    command_id: str
    held_clauses: list[str]
    question: str
    options: list[str]
    agent: str
    created_at: float = field(default_factory=time.monotonic)


@dataclass
class PlanJournalEntry:
    command_id: str
    text: str
    say: str
    mode: str
    steps: list[Intent] = field(default_factory=list)
    packets: list[CommandPacket] = field(default_factory=list)
    pre_scene: SceneState | None = None


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
        self.latest_scene: SceneState | None = None
        self.latest_full_scene: SceneState | None = None
        self.prev_scene: SceneState | None = None
        self.scene_event: asyncio.Event = asyncio.Event()
        self.recent_server_edits: dict[str, float] = {}
        self.last_command_at: float = 0.0
        self.command_in_flight: bool = False
        self.suggestion_gate: SuggestionGate = SuggestionGate(time.monotonic, GateConfig.from_env())
        self._pending_plan: PendingPlan | None = None
        self._plan_cancel: asyncio.Event = asyncio.Event()
        self.plan_journal: deque[PlanJournalEntry] = deque(maxlen=4)

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

    def update_scene(self, msg: SceneState) -> None:
        self.prev_scene = self.latest_scene
        if msg.mode == "full":
            self.latest_full_scene = msg
            self.latest_scene = msg
        else:
            self.latest_scene = msg
            if self.latest_full_scene is not None:
                self.latest_scene = self._merge_full_tracks(msg, self.latest_full_scene)
        self.scene_event.set()

    def _merge_full_tracks(
        self, heartbeat: SceneState, full: SceneState
    ) -> SceneState:
        """Copy full keyframe tracks from a full snapshot into a heartbeat scene
        for objects whose track summary counts match."""
        from .schema import KeyframeTrackFull

        merged_objects = []
        for obj in heartbeat.objects:
            full_obj = next((o for o in full.objects if o.id == obj.id), None)
            if full_obj is None:
                merged_objects.append(obj)
                continue
            merged_tracks = []
            for hb_track in obj.tracks:
                matching_full = next(
                    (t for t in full_obj.tracks
                     if isinstance(t, KeyframeTrackFull)
                     and t.property == hb_track.property),
                    None,
                )
                if matching_full is not None:
                    merged_tracks.append(matching_full)
                else:
                    merged_tracks.append(hb_track)
            merged_objects.append(obj.model_copy(update={"tracks": merged_tracks}))
        return heartbeat.model_copy(update={"objects": merged_objects})

    def note_server_edit(self, packet: CommandPacket) -> None:
        now = time.monotonic()
        key = _server_edit_key(packet)
        if key:
            self.recent_server_edits[key] = now
        # Prune entries older than 10s
        cutoff = now - 10.0
        self.recent_server_edits = {
            k: v for k, v in self.recent_server_edits.items() if v >= cutoff
        }

    def command_started(self) -> None:
        self.last_command_at = time.monotonic()
        self.command_in_flight = True

    def command_finished(self) -> None:
        self.command_in_flight = False
        self.last_command_at = time.monotonic()

    def clear(self) -> None:
        self._history.clear()
        self._pending_target = None
        self._pending_addressee = None
        self._last_transform = None
        self._pending_clarify = None
        self._clarify_target = None
        self.recent_notes.clear()
        self.latest_scene = None
        self.latest_full_scene = None
        self.prev_scene = None
        self.scene_event = asyncio.Event()
        self.recent_server_edits.clear()
        self.last_command_at = 0.0
        self.command_in_flight = False
        self.suggestion_gate = SuggestionGate(time.monotonic, GateConfig.from_env())
        self._pending_plan = None
        self._plan_cancel = asyncio.Event()
        self.plan_journal.clear()

    def set_pending_plan(self, plan: PendingPlan) -> None:
        self._pending_plan = plan
        self._plan_cancel.clear()

    def pending_plan(self) -> PendingPlan | None:
        return self._pending_plan

    def clear_pending_plan(self) -> None:
        self._pending_plan = None

    def cancel_active_plan(self) -> None:
        """Signal an in-flight planner loop from a prior command to stop."""
        self._plan_cancel.set()
        self._pending_plan = None

    def begin_plan(self) -> None:
        """Fresh plan for this command — clear stale cancel from command_started()."""
        self._plan_cancel.clear()

    def plan_cancelled(self) -> asyncio.Event:
        return self._plan_cancel

    def record_plan(self, entry: PlanJournalEntry) -> None:
        self.plan_journal.append(entry)

    def latest_plan(self) -> PlanJournalEntry | None:
        return self.plan_journal[-1] if self.plan_journal else None

    def pop_latest_plan(self) -> PlanJournalEntry | None:
        return self.plan_journal.pop() if self.plan_journal else None


def _server_edit_key(packet: CommandPacket) -> str | None:
    """Category key for suppressing observer reactions to crew-emitted edits."""
    cmd = packet.command
    if cmd in ("TRANSFORM_OBJECT", "ANIMATE_OBJECT", "SET_KEYFRAMES", "SET_MATERIAL"):
        target = getattr(packet.payload, "target", None)
        if target and target.name:
            return f"{cmd}:{target.name}"
        if target and target.id:
            return f"{cmd}:{target.id}"
    if cmd == "SPAWN_OBJECT":
        name = packet.payload.name or packet.payload.id
        if name:
            return f"SPAWN:{name}"
    if cmd == "UPDATE_LIGHTS":
        return "UPDATE_LIGHTS"
    if cmd == "UPDATE_FX":
        return "UPDATE_FX"
    if cmd == "MOVE_CAMERA":
        return "MOVE_CAMERA"
    if cmd == "PLAYBACK":
        return "PLAYBACK"
    return None


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
