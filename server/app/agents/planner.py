"""Bounded plan-act-observe loop for open creative direction (Phase B)."""
from __future__ import annotations

import asyncio
import logging
import re
import time

from .. import llm, session_context
from ..schema import Intent, SceneState

log = logging.getLogger("director.planner")

MAX_BEATS = 4
WALL_CLOCK_SEC = 25.0
OBSERVE_SEC = 2.0

PLAN_ADDENDUM = """
PLAN MODE: Return intents for the FIRST beat only as mutating/describe intents.
End with ONE describe intent whose describe_message starts with "PLAN:" listing
all beats numbered 1) 2) 3) … Include only the first beat's actionable intents
before the PLAN describe intent.
"""


def _parse_plan_line(message: str | None) -> tuple[str, list[str]]:
    if not message or not message.strip().upper().startswith("PLAN:"):
        return "", []
    body = message.split(":", 1)[1].strip()
    beats = re.findall(r"\d+\)\s*[^;\d]+", body)
    return body, [b.strip() for b in beats]


class Planner:
    def __init__(self, producer) -> None:
        self._producer = producer

    async def run(
        self,
        text: str,
        scene: SceneState | None,
        command_id: str | None,
        emit_log,
        emit_packet,
        emit_status,
        frame,
        emit_cancel,
        emit_suggest,
    ) -> tuple[list, bool]:
        """Returns (packets, describe_only)."""
        session = session_context.get_session()
        session.begin_plan()
        started = time.monotonic()
        all_packets: list = []
        beat = 0
        plan_text = ""
        remaining: list[str] = []

        while beat < MAX_BEATS and (time.monotonic() - started) < WALL_CLOCK_SEC:
            if session.plan_cancelled().is_set():
                await emit_log("Producer", "plan cut short — new direction", "warn")
                break

            prompt = text if beat == 0 else f"Continue plan. Completed: {plan_text}. Remaining: {remaining}"
            scene_now = session.latest_scene or scene
            intents: list[Intent] = []
            async for intent in llm.stream_intents(
                prompt + "\n" + PLAN_ADDENDUM,
                scene_now,
                frame,
            ):
                intents.append(intent)

            if not intents:
                break

            plan_intents = [i for i in intents if i.action == "describe" and i.describe_message]
            mutating = [i for i in intents if i.action not in ("describe", "suggest", "clarify")]

            for pi in plan_intents:
                _, beats = _parse_plan_line(pi.describe_message)
                if beats:
                    plan_text = pi.describe_message or ""
                    remaining = beats[1:]
                    await emit_log("Producer", plan_text, "info")
                    await emit_status("Producer", "active", command_id, f"beat {beat + 1}/{len(beats)}")
                    break

            if mutating:
                rescued = await self._producer._stream_intents(
                    mutating,
                    command_id,
                    emit_log,
                    emit_packet,
                    emit_status,
                    scene_now,
                    emit_cancel,
                    emit_suggest,
                )
                all_packets.extend(rescued)

            beat += 1
            if not remaining:
                break

            try:
                session.scene_event.clear()
                await asyncio.wait_for(session.scene_event.wait(), OBSERVE_SEC)
            except asyncio.TimeoutError:
                pass

        session.clear_pending_plan()
        await emit_status("Producer", "idle", command_id, None)
        return all_packets, False
