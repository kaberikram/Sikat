"""Producer: coordinates the crew."""
from __future__ import annotations

from ..mood_presets import mood_packets
from ..schema import (
    CommandPacket,
    Intent,
    PlaybackPacket,
    PlaybackPayload,
    SceneState,
)
from .asset_animator import AssetAnimator
from .base import EmitLog, _noop_emit
from .directors_assistant import DirectorsAssistant
from .lighting_tech import LightingTech
from .vfx_operator import VFXOperator


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
