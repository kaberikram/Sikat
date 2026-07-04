"""Producer: coordinates the crew."""
from __future__ import annotations

import asyncio

from .. import session_context
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
        # Commit to conversation memory in parse-completion order (captures both
        # the LLM and fallback results) so the next command can resolve pronouns
        # and relative corrections against this one.
        session_context.record(text, intents)
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

        # Narrate the assignment up front so the crew's plan is visible while the
        # packets are still streaming out over the step delays below.
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
        return packets
