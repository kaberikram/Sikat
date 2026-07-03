"""Producer: coordinates the crew.

Routes Director's Assistant intents to specialists, expands whole-scene mood
macros, owns playback, and stamps every outgoing packet with the originating
commandId. Straight parse -> route -> emit pipeline; no graph framework needed.
"""
from __future__ import annotations

from ..schema import (
    CommandPacket,
    Intent,
    PlaybackPacket,
    PlaybackPayload,
    SceneState,
    UpdateFxPacket,
    UpdateLightsPacket,
    UpdateLightsPayload,
)
from .asset_animator import AssetAnimator
from .base import EmitLog, _noop_emit
from .directors_assistant import DirectorsAssistant
from .lighting_tech import LightingTech
from .vfx_operator import VFXOperator


def _mood_packets(mood: str) -> list[CommandPacket]:
    """SET_SCENE macro: a mood expands into UPDATE_LIGHTS + UPDATE_FX batches."""
    if mood == "noir":
        return [
            UpdateLightsPacket(
                payload=UpdateLightsPayload.model_validate(
                    {
                        "ambient": {"color": "#9aa0b4", "intensity": 0.25},
                        "key": {"color": "#dfe6ff", "intensity": 2.4, "position": (6, 9, 3)},
                        "background": "#14161d",
                    }
                )
            ),
            UpdateFxPacket(
                payload={
                    "section": "dither",
                    "patch": {"enabled": True, "monochrome": True, "strength": 0.8},
                }
            ),
            UpdateFxPacket(payload={"section": "bloom", "patch": {"enabled": False}}),
        ]
    if mood == "sunset":
        return [
            UpdateLightsPacket(
                payload=UpdateLightsPayload.model_validate(
                    {
                        "ambient": {"color": "#ffb27a", "intensity": 0.55},
                        "key": {"color": "#ff6b35", "intensity": 1.9, "position": (-6, 3, 5)},
                        "background": "#ffd9a0",
                    }
                )
            ),
            UpdateFxPacket(
                payload={
                    "section": "bloom",
                    "patch": {"enabled": True, "strength": 1.2, "threshold": 0.3},
                }
            ),
            UpdateFxPacket(payload={"section": "dither", "patch": {"enabled": False}}),
        ]
    if mood == "neon":
        return [
            UpdateLightsPacket(
                payload=UpdateLightsPayload.model_validate(
                    {
                        "ambient": {"color": "#7b5cff", "intensity": 0.5},
                        "key": {"color": "#00ffe1", "intensity": 2.2, "position": (4, 8, 6)},
                        "background": "#0b0b17",
                    }
                )
            ),
            UpdateFxPacket(
                payload={
                    "section": "bloom",
                    "patch": {"enabled": True, "strength": 1.6, "threshold": 0.15},
                }
            ),
        ]
    if mood == "studio":
        # Reset to the editor's built-in defaults.
        return [
            UpdateLightsPacket(
                payload=UpdateLightsPayload.model_validate(
                    {
                        "ambient": {"color": "#ffffff", "intensity": 0.8},
                        "key": {"color": "#ffffff", "intensity": 1.5, "position": (5, 10, 7)},
                        "background": "#f2f2f2",
                    }
                )
            ),
            UpdateFxPacket(payload={"section": "bloom", "patch": {"enabled": False}}),
            UpdateFxPacket(payload={"section": "glitch", "patch": {"enabled": False}}),
            UpdateFxPacket(payload={"section": "dither", "patch": {"enabled": False}}),
        ]
    return []


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
            return _mood_packets(intent.mood)
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
                if intent.action == "set_scene" and built:
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
