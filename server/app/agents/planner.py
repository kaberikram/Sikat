"""Whole-utterance plan-act-observe loop for Director Mode."""
from __future__ import annotations

import asyncio
import logging
import time

from .. import fallback_parser, llm, motion_floor, session_context
from ..schema import CommandPacket, Intent, SceneState, plan_update_message

log = logging.getLogger("director.planner")

MAX_ROUNDS = 2
MAX_STEPS = 6
WALL_CLOCK_SEC = 30.0
OBSERVE_SEC = 2.0

class PlanRunner:
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
        emit_question,
        emit_plan_update,
        *,
        prefer_strong: bool = False,
    ) -> tuple[list, bool]:
        """Run a streamed DirectorPlan, returning staged packets and describe state."""
        session = session_context.get_session()
        session.begin_plan()
        started = time.monotonic()
        all_packets: list[CommandPacket] = []
        all_steps: list[Intent] = []
        plan_say = ""
        plan_mode = "execute"
        describe_only = True
        escalated = prefer_strong
        scene_now = scene

        for round_index in range(MAX_ROUNDS):
            if time.monotonic() - started >= WALL_CLOCK_SEC:
                break
            if session.plan_cancelled().is_set():
                await emit_log("Producer", "plan cut short — new direction", "warn")
                break
            scene_now = session.latest_scene or scene
            adjustment = round_index > 0
            prompt = text if not adjustment else f"Adjust the previous result of: {text}"
            emitted_steps = 0
            escalation_requested = False
            async for event in llm.stream_plan(
                prompt,
                scene_now,
                frame,
                tier="strong" if escalated else "fast",
                extra_context=self._journal_context(session.latest_plan()),
                adjustment=adjustment,
            ):
                if isinstance(event, llm.Say):
                    plan_say = event.text
                    await emit_status("Producer", "active", command_id, event.text)
                    await emit_plan_update(
                        plan_update_message(command_id or "", status="planning", say=event.text)
                    )
                elif isinstance(event, llm.Meta):
                    plan_mode = event.mode
                    if event.needs_deeper_creativity and not escalated:
                        escalated = True
                        escalation_requested = True
                        await emit_status(
                            "Producer", "active", command_id, "bringing in the director of photography"
                        )
                        await emit_plan_update(
                            plan_update_message(command_id or "", status="escalating", mode=plan_mode)
                        )
                        break
                elif isinstance(event, llm.Step):
                    cap = 3 if adjustment else 4 if plan_mode == "surprise" else MAX_STEPS
                    if emitted_steps >= cap:
                        continue
                    emitted_steps += 1
                    step = event.step
                    all_steps.append(step)
                    if plan_mode == "pitch":
                        await self._producer._emit_suggest(step, emit_suggest)
                        continue
                    if step.action == "describe":
                        await self._producer._emit_describe(step, emit_log)
                        continue
                    if step.action == "suggest":
                        await self._producer._emit_suggest(step, emit_suggest)
                        continue
                    if step.action == "clarify":
                        await self._producer._emit_clarify(
                            step, text, command_id, emit_log, emit_question,
                            emit_cancel, emit_packet, emit_status, scene_now
                        )
                        return all_packets, True
                    describe_only = False
                    await emit_plan_update(
                        plan_update_message(
                            command_id or "",
                            status="step_start",
                            mode=plan_mode,
                            step_index=len(all_steps),
                            step_label=step.say or step.action,
                        )
                    )
                    built = await self._producer._emit_staged_intent(
                        step, command_id, emit_log, emit_packet, emit_status, emit_cancel, scene_now,
                        utterance=text,
                    )
                    all_packets.extend(built)
                    await emit_plan_update(
                        plan_update_message(
                            command_id or "", status="step_done", mode=plan_mode,
                            step_index=len(all_steps), step_label=step.say or step.action
                        )
                    )
            if escalation_requested:
                continue
            if plan_mode == "pitch":
                await emit_plan_update(plan_update_message(command_id or "", status="pitched", mode=plan_mode))
                break
            if not all_steps or adjustment:
                break
            await emit_plan_update(plan_update_message(command_id or "", status="adjusting", mode=plan_mode))
            session.scene_event.clear()
            try:
                await asyncio.wait_for(session.scene_event.wait(), OBSERVE_SEC)
            except asyncio.TimeoutError:
                pass

        all_packets, describe_only = await self._recover_empty_plan(
            text, scene_now, frame, command_id, plan_say, plan_mode,
            all_packets, all_steps, describe_only,
            emit_log, emit_packet, emit_status, emit_cancel,
        )

        session.clear_pending_plan()
        if not all_steps and not session.plan_cancelled().is_set():
            rescue = fallback_parser.parse(text, scene)
            if rescue:
                await emit_log("Producer", "planner missed — applying rule-parser rescue", "warn")
                all_steps.extend(rescue)
                all_packets.extend(
                    await self._producer._stream_intents(
                        rescue, command_id, emit_log, emit_packet, emit_status,
                        scene, emit_cancel, emit_suggest
                    )
                )
                describe_only = not all_packets
        if all_steps:
            session.record(text, all_steps)
            session.record_plan(
                session_context.PlanJournalEntry(
                    command_id=command_id or "", text=text, say=plan_say, mode=plan_mode,
                    steps=all_steps, packets=all_packets, pre_scene=scene
                )
            )
        await emit_plan_update(
            plan_update_message(command_id or "", status="done", say=plan_say, mode=plan_mode,
                                steps_total=len(all_steps))
        )
        return all_packets, describe_only

    async def _recover_empty_plan(
        self,
        text: str,
        scene_now: SceneState | None,
        frame,
        command_id: str | None,
        plan_say: str,
        plan_mode: str,
        all_packets: list[CommandPacket],
        all_steps: list[Intent],
        describe_only: bool,
        emit_log,
        emit_packet,
        emit_status,
        emit_cancel,
    ) -> tuple[list[CommandPacket], bool]:
        """Escalation chain: corrective re-plan -> motion floor -> honest state."""
        action_seeking = motion_floor.is_animation_seeking(text) or not describe_only
        if not all_packets and plan_mode != "pitch":
            if plan_say or action_seeking:
                await emit_status("Producer", "active", command_id, "rethinking that…")
                recovery_steps = 0
                async for event in llm.stream_plan(
                    text,
                    scene_now,
                    frame,
                    tier="strong",
                    extra_context=(
                        "Your previous plan produced ZERO executable steps "
                        "(all were dropped as invalid). Return concrete mutating "
                        "steps now. Keyframe values must be [x,y,z] with exactly "
                        "3 numbers."
                    ),
                    adjustment=True,
                ):
                    if isinstance(event, llm.Say):
                        pass
                    elif isinstance(event, llm.Meta):
                        pass
                    elif isinstance(event, llm.Step):
                        if recovery_steps >= 4:
                            continue
                        recovery_steps += 1
                        step = event.step
                        all_steps.append(step)
                        if step.action in ("describe", "suggest", "clarify", "pitch"):
                            continue
                        describe_only = False
                        built = await self._producer._emit_staged_intent(
                            step, command_id, emit_log, emit_packet, emit_status,
                            emit_cancel, scene_now, utterance=text,
                        )
                        all_packets.extend(built)
            if not all_packets and action_seeking:
                await emit_log("Producer", "plan didn't land — improvising a take", "warn")
                floor = motion_floor.motion_floor_packets(text, command_id)
                for pkt in floor:
                    pkt.commandId = command_id
                    await emit_packet(pkt)
                all_packets.extend(floor)
                describe_only = False
            if plan_say and not all_packets:
                describe_only = False
        return all_packets, describe_only

    @staticmethod
    def _journal_context(entry: session_context.PlanJournalEntry | None) -> str | None:
        if entry is None:
            return None
        steps = ", ".join(step.action for step in entry.steps)
        return f'Last direction: "{entry.text}"\\nMode: {entry.mode}\\nSteps: {steps}'
