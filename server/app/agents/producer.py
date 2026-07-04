"""Producer: coordinates the crew."""
from __future__ import annotations

import asyncio

from .. import llm, performers, session_context
from ..fallback_parser import parse_one_clause, split_clauses
from ..mood_presets import mood_packets
from ..schema import (
    CommandPacket,
    Intent,
    PlaybackPacket,
    PlaybackPayload,
    SceneFrame,
    SceneState,
)
from .asset_animator import AssetAnimator
from .base import (
    EmitLog,
    EmitPacket,
    EmitStatus,
    _noop_emit,
    _noop_packet,
    _noop_status,
)
from .directors_assistant import DirectorsAssistant
from .lighting_tech import LightingTech
from .vfx_operator import VFXOperator

# Server-side pacing. Kept intentionally light: the client owns the real
# choreography (flight/hover/settle). These sleeps only interleave the crew so
# statuses and packets stream over a few hundred ms instead of one burst.
AGENT_STEP_DELAY = 0.25  # between successive packets from the same specialist
AGENT_STAGGER = 0.15  # head-start offset between specialists so cursors fan out

# Present-tense verb per command, shown on the agent's cursor as a "note" the
# instant it goes active — fills the parse latency ("dead air") so the crew's
# thinking is visible before the first packet lands. The client refines these
# per packet as work proceeds (e.g. "tracing bounce 12/25").
_COMMAND_NOTE = {
    "SPAWN_OBJECT": "spawning",
    "REMOVE_OBJECT": "removing",
    "TRANSFORM_OBJECT": "moving",
    "ANIMATE_OBJECT": "animating",
    "MOVE_CAMERA": "framing shot",
    "UPDATE_LIGHTS": "lighting",
    "SET_MATERIAL": "painting",
    "UPDATE_FX": "compositing",
    "SET_KEYFRAMES": "keyframing",
    "PLAYBACK": "cueing",
}


def _agent_note(agent_packets: list[CommandPacket]) -> str:
    """A short 'what am I doing' note derived from the agent's first packet."""
    if not agent_packets:
        return "working"
    return _COMMAND_NOTE.get(agent_packets[0].command, "working")


class Producer:
    name = "Producer"

    def __init__(self) -> None:
        self.assistant = DirectorsAssistant()
        self.specialists = [AssetAnimator(), LightingTech(), VFXOperator()]
        self._routes = {
            action: specialist
            for specialist in self.specialists
            for action in specialist.actions
        }

    def _build_own(self, intent: Intent) -> list[CommandPacket]:
        if intent.action == "playback" and intent.playback_action:
            packets = [
                PlaybackPacket(
                    payload=PlaybackPayload(
                        action=intent.playback_action, time=intent.seek_time
                    )
                )
            ]
            if intent.playback_pause_after_seek:
                packets.append(PlaybackPacket(payload=PlaybackPayload(action="pause")))
            return packets
        if intent.action == "set_scene" and intent.mood:
            packets = mood_packets(intent.mood)
            if not packets:
                return []
            return packets
        return []

    async def _emit_describe(
        self, intent: Intent, emit: EmitLog = _noop_emit
    ) -> None:
        await emit(
            self.assistant.name,
            intent.describe_message or "Scene description requested.",
            "info",
        )

    async def _build_packets_for_intent(
        self,
        intent: Intent,
        emit: EmitLog = _noop_emit,
        emit_status: EmitStatus = _noop_status,
        command_id: str | None = None,
    ) -> list[CommandPacket]:
        if intent.action == "assign":
            if intent.addressee and intent.target:
                performers.assign(intent.addressee, intent.target, intent.role)
                agent = f"Agent{intent.addressee}"
                await emit(
                    self.name,
                    f"Agent {intent.addressee} on {intent.target}",
                    "info",
                )
                await emit_status(agent, "active", command_id, "assigned")
                await emit_status(agent, "idle", command_id, "copy")
            return []

        if intent.action in ("playback", "set_scene"):
            built = self._build_own(intent)
            if intent.action == "set_scene" and intent.mood and not built:
                await emit(self.name, f"unknown mood '{intent.mood}'", "warn")
            elif intent.action == "set_scene" and built:
                await emit(
                    self.name, f"mood '{intent.mood}' -> {len(built)} packets", "info"
                )
            return built

        specialist = self._routes.get(intent.action)
        working = intent
        if intent.addressee and not intent.target:
            assignment = performers.get(intent.addressee)
            if assignment:
                working = intent.model_copy(update={"target": assignment.target})
        built = specialist.build(working) if specialist else []
        if built and specialist:
            await emit(
                specialist.name,
                ", ".join(p.command for p in built),
                "info",
            )
        if intent.addressee and built:
            agent = f"Agent{intent.addressee}"
            for packet in built:
                packet.target_agent = agent  # type: ignore[assignment]
        if not built:
            await emit(self.name, f"dropped unactionable intent: {intent.action}", "warn")
        return built

    async def _build_packets_for_intents(
        self,
        intents: list[Intent],
        emit: EmitLog = _noop_emit,
        emit_status: EmitStatus = _noop_status,
        command_id: str | None = None,
    ) -> list[CommandPacket]:
        packets: list[CommandPacket] = []
        for intent in intents:
            if intent.action == "describe":
                continue
            packets.extend(
                await self._build_packets_for_intent(
                    intent, emit, emit_status, command_id
                )
            )
        return packets

    async def _stream_packets_staged(
        self,
        packets: list[CommandPacket],
        command_id: str | None,
        emit_log: EmitLog,
        emit_packet: EmitPacket,
        emit_status: EmitStatus,
    ) -> None:
        if not packets:
            return

        groups: dict[str, list[CommandPacket]] = {}
        for packet in packets:
            packet.commandId = command_id
            groups.setdefault(packet.target_agent, []).append(packet)

        assignment = ", ".join(
            f"{agent}→{'/'.join(dict.fromkeys(p.command for p in pkts))}"
            for agent, pkts in groups.items()
        )
        await emit_log(self.name, f"assigning: {assignment}", "info")

        async def run_specialist(
            index: int, agent: str, agent_packets: list[CommandPacket]
        ) -> None:
            await asyncio.sleep(index * AGENT_STAGGER)
            await emit_status(agent, "active", command_id, _agent_note(agent_packets))
            for step, packet in enumerate(agent_packets):
                if step:
                    await asyncio.sleep(AGENT_STEP_DELAY)
                await emit_packet(packet)
            await emit_status(agent, "idle", command_id, "done")

        await asyncio.gather(
            *(
                run_specialist(index, agent, agent_packets)
                for index, (agent, agent_packets) in enumerate(groups.items())
            )
        )

    async def handle_user_command(
        self,
        text: str,
        scene: SceneState | None,
        command_id: str | None = None,
        emit: EmitLog = _noop_emit,
        emit_status: EmitStatus = _noop_status,
        frame: SceneFrame | None = None,
    ) -> tuple[list[CommandPacket], bool]:
        """Returns (packets, describe_only). describe_only suppresses no-op errors."""
        intents, source = await self.assistant.parse(text, scene, frame)
        session_context.record(text, intents)
        await emit(
            self.assistant.name,
            f"parsed {len(intents)} intent(s) via {source}",
            "info" if intents else "warn",
        )

        describe_intents = [i for i in intents if i.action == "describe"]
        mutating_intents = [i for i in intents if i.action != "describe"]

        for intent in describe_intents:
            await self._emit_describe(intent, emit)

        if describe_intents and not mutating_intents:
            return [], True

        packets = await self._build_packets_for_intents(
            mutating_intents, emit, emit_status, command_id
        )
        for packet in packets:
            packet.commandId = command_id

        if not packets and any(i.action == "assign" for i in mutating_intents):
            return [], True

        return packets, False

    async def _direct_single_clause(
        self,
        text: str,
        scene: SceneState | None,
        command_id: str | None,
        emit_log: EmitLog,
        emit_packet: EmitPacket,
        emit_status: EmitStatus,
        frame: SceneFrame | None,
    ) -> tuple[list[CommandPacket], bool]:
        packets, describe_only = await self.handle_user_command(
            text, scene, command_id, emit_log, emit_status, frame
        )
        if not packets:
            return packets, describe_only

        await self._stream_packets_staged(
            packets, command_id, emit_log, emit_packet, emit_status
        )
        return packets, False

    async def _direct_multi_clause(
        self,
        text: str,
        clauses: list[str],
        scene: SceneState | None,
        command_id: str | None,
        emit_log: EmitLog,
        emit_packet: EmitPacket,
        emit_status: EmitStatus,
        frame: SceneFrame | None,
    ) -> tuple[list[CommandPacket], bool]:
        llm_task: asyncio.Task | None = None
        if llm.select_provider(frame) is not None:
            llm_task = asyncio.create_task(llm.parse_intents(text, scene, frame))
            await emit_log(
                self.assistant.name,
                f"streaming {len(clauses)} clause(s); LLM in parallel",
                "info",
            )

        handled: list[bool] = []
        all_intents: list[Intent] = []
        all_packets: list[CommandPacket] = []
        describe_only = True

        for clause in clauses:
            intent = parse_one_clause(clause, scene)
            handled.append(intent is not None)
            if intent is None:
                continue
            all_intents.append(intent)
            if intent.action == "describe":
                await self._emit_describe(intent, emit_log)
                continue
            describe_only = False
            built = await self._build_packets_for_intent(
                intent, emit_log, emit_status, command_id
            )
            for packet in built:
                packet.commandId = command_id
            all_packets.extend(built)
            await self._stream_packets_staged(
                built, command_id, emit_log, emit_packet, emit_status
            )

        if llm_task is not None:
            llm_result = await llm_task
            if llm_result and llm_result.intents:
                source = "llm"
                for index, intent in enumerate(llm_result.intents):
                    if index < len(handled) and handled[index]:
                        continue
                    all_intents.append(intent)
                    if intent.action == "describe":
                        await self._emit_describe(intent, emit_log)
                        continue
                    describe_only = False
                    built = await self._build_packets_for_intent(
                intent, emit_log, emit_status, command_id
            )
                    for packet in built:
                        packet.commandId = command_id
                    all_packets.extend(built)
                    await self._stream_packets_staged(
                        built, command_id, emit_log, emit_packet, emit_status
                    )
            else:
                source = "fallback"
        else:
            source = "fallback"

        session_context.record(text, all_intents)
        await emit_log(
            self.assistant.name,
            f"parsed {len(all_intents)} intent(s) via {source}",
            "info" if all_intents else "warn",
        )

        if describe_only and all_intents:
            return [], True
        return all_packets, False

    async def direct(
        self,
        text: str,
        scene: SceneState | None,
        command_id: str | None = None,
        emit_log: EmitLog = _noop_emit,
        emit_packet: EmitPacket = _noop_packet,
        emit_status: EmitStatus = _noop_status,
        frame: SceneFrame | None = None,
    ) -> tuple[list[CommandPacket], bool]:
        """Staged execution: plan the crew's work, then stream it over time.

        Multi-clause commands stream fallback-parsed clauses immediately while
        the LLM (when configured) finishes the full sentence in parallel.

        Returns (packets, describe_only). When describe_only is True the command
        was satisfied with agent_log messages only — no error should be emitted.
        """
        clauses = split_clauses(text)
        if len(clauses) <= 1:
            return await self._direct_single_clause(
                text,
                scene,
                command_id,
                emit_log,
                emit_packet,
                emit_status,
                frame,
            )

        return await self._direct_multi_clause(
            text,
            clauses,
            scene,
            command_id,
            emit_log,
            emit_packet,
            emit_status,
            frame,
        )
