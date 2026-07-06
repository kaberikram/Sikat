"""Proactive crew observer — per-session scene watcher."""
from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid

from fastapi import WebSocket

from .crew_huddle import phrase_observation
from .heuristics import (
    ObserverMemory,
    Observation,
    diff_scene,
    manual_edit_observation,
    run_detectors,
)
from .schema import SceneState, agent_status_message, agent_suggestion_message
from .session_context import SessionContext
from .suggestion_gate import GateConfig, SuggestionGate

log = logging.getLogger("director.observer")

DEBOUNCE_SEC = 0.5
COMMAND_MUTE_SEC = 5.0
IDLE_AFTER_SUGGEST_SEC = 2.0


def _proactive_enabled() -> bool:
    return os.getenv("DIRECTOR_PROACTIVE", "1") not in ("0", "false", "False", "no")


async def run_observer(session: SessionContext, ws: WebSocket) -> None:
    memory = ObserverMemory()
    gate = session.suggestion_gate
    try:
        while True:
            await session.scene_event.wait()
            session.scene_event.clear()
            await asyncio.sleep(DEBOUNCE_SEC)
            if not _proactive_enabled():
                continue
            await _observer_cycle(session, ws, memory, gate)
    except asyncio.CancelledError:
        log.debug("observer cancelled")
        raise


async def _observer_cycle(
    session: SessionContext,
    ws: WebSocket,
    memory: ObserverMemory,
    gate: SuggestionGate,
) -> None:
    now = time.monotonic()
    if session.command_in_flight:
        return
    if now - session.last_command_at < COMMAND_MUTE_SEC:
        return

    prev = session.prev_scene
    curr = session.latest_scene
    if curr is None:
        return

    observations = run_detectors(prev, curr, memory)
    manual_edits = diff_scene(prev, curr, session.recent_server_edits, now=now)
    for edit in manual_edits[:1]:
        observations.append(manual_edit_observation(edit))

    if not observations:
        gate.update_active_dedupes(set())
        return

    gate.update_active_dedupes({o.dedupe_key for o in observations})
    observations.sort(key=lambda o: o.severity, reverse=True)
    obs = observations[0]

    is_manual = obs.kind == "manual_edit"
    if not gate.allow(obs.kind, obs.dedupe_key, is_manual=is_manual):
        return

    is_reaction = is_manual
    kind = "reaction" if is_reaction else "observation"

    use_llm = not is_manual and gate.try_consume_llm_token()
    if use_llm:
        phrased = await phrase_observation(obs, curr)
        say = str(phrased["say"])
        suggested = phrased.get("suggested_command") or obs.suggested_command
    else:
        say = obs.template_line
        suggested = obs.suggested_command

    suggestion_id = str(uuid.uuid4())
    try:
        await ws.send_json(agent_status_message(obs.agent, "active", None, say))
        await ws.send_json(
            agent_suggestion_message(
                obs.agent,
                suggestion_id,
                say,
                suggested_command=suggested,
                subject_object=obs.subject_object,
                kind=kind,
            )
        )
        await asyncio.sleep(IDLE_AFTER_SUGGEST_SEC)
        await ws.send_json(agent_status_message(obs.agent, "idle", None, None))
    except Exception as exc:
        log.debug("observer emit failed: %s", exc)
        return

    gate.record(obs.kind, obs.dedupe_key, is_manual=is_manual, used_llm=use_llm)


async def emit_suggestion_from_producer(
    ws: WebSocket,
    obs: Observation,
    *,
    kind: str = "suggestion",
    scene: SceneState | None = None,
    gate: SuggestionGate | None = None,
) -> bool:
    """Route producer suggest-intent through the gate (A5)."""
    g = gate or SuggestionGate(time.monotonic)
    if not g.allow(obs.kind, obs.dedupe_key):
        return False

    use_llm = g.try_consume_llm_token()
    if use_llm:
        phrased = await phrase_observation(obs, scene)
        say = str(phrased["say"])
        suggested = phrased.get("suggested_command") or obs.suggested_command
    else:
        say = obs.template_line
        suggested = obs.suggested_command

    suggestion_id = str(uuid.uuid4())
    await ws.send_json(agent_status_message(obs.agent, "active", None, say))
    await ws.send_json(
        agent_suggestion_message(
            obs.agent,
            suggestion_id,
            say,
            suggested_command=suggested,
            subject_object=obs.subject_object,
            kind=kind,
        )
    )
    await asyncio.sleep(IDLE_AFTER_SUGGEST_SEC)
    await ws.send_json(agent_status_message(obs.agent, "idle", None, None))
    g.record(obs.kind, obs.dedupe_key, used_llm=use_llm)
    return True
