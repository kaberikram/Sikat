"""Producer: coordinates the crew."""
from __future__ import annotations

import asyncio

from ..mood_presets import mood_packets
from ..schema import (
    CommandPacket,
    Intent,
    PlaybackPacket,
    PlaybackPayload,
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
            return [
                PlaybackPacket(
                    payload=PlaybackPayload(
                        action=intent.playback_action, time=intent.seek_time
                    )
                )
            ]
        if intent.action == "set_scene" and intent.mood:
            packets = mood_packets(intent.mood)
            if not packets:
                return []
            return packets
        return []

    async def handle_user_command(
        self,
        text: str,
        scene: SceneState | None,
        command_id: str | None = None,
        emit: EmitLog = _noop_emit,
    ) -> list[CommandPacket]:
        intents, source = await self.assistant.parse(text, scene)
        await emit(
            self.assistant.name,
            f"parsed {len(intents)} intent(s) via {source}",
            "info" if intents else "warn",
        )
        packets: list[CommandPacket] = []
        for intent in intents:
            if intent.action in ("playback", "set_scene"):
                built = self._build_own(intent)
                if intent.action == "set_scene" and intent.mood and not built:
                    await emit(self.name, f"unknown mood '{intent.mood}'", "warn")
                elif intent.action == "set_scene" and built:
                    await emit(self.name, f"mood '{intent.mood}' -> {len(built)} packets", "info")
            else:
                specialist = self._routes.get(intent.action)
                built = specialist.build(intent) if specialist else []
                if built and specialist:
                    await emit(
                        specialist.name,
                        ", ".join(p.command for p in built),
                        "info",
                    )
            if not built:
                await emit(self.name, f"dropped unactionable intent: {intent.action}", "warn")
            packets.extend(built)
        for packet in packets:
            packet.commandId = command_id
        return packets

    async def direct(
        self,
        text: str,
        scene: SceneState | None,
        command_id: str | None = None,
        emit_log: EmitLog = _noop_emit,
        emit_packet: EmitPacket = _noop_packet,
        emit_status: EmitStatus = _noop_status,
    ) -> list[CommandPacket]:
        """Staged execution: plan the crew's work, then stream it over time.

        The plan (parse + build) is unchanged and fully deterministic — see
        ``handle_user_command``. What's new is the delivery: packets are grouped
        by their target specialist and each specialist runs as a concurrent
        worker that announces itself (``active``), emits its packets with a small
        step delay, then stands down (``idle``). The crew therefore interleaves
        so the client can render several agent cursors working at once.
        """
        packets = await self.handle_user_command(text, scene, command_id, emit_log)
        if not packets:
            return packets

        groups: dict[str, list[CommandPacket]] = {}
        for packet in packets:
            groups.setdefault(packet.target_agent, []).append(packet)

        async def run_specialist(
            index: int, agent: str, agent_packets: list[CommandPacket]
        ) -> None:
            await asyncio.sleep(index * AGENT_STAGGER)
            await emit_status(agent, "active", command_id, f"{len(agent_packets)} task(s)")
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
        return packets
