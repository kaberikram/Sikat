"""Lighting Tech: scene lighting and object materials."""
from __future__ import annotations

from ..schema import (
    AmbientLightPatch,
    CommandPacket,
    Intent,
    KeyLightPatch,
    SetMaterialPacket,
    SetMaterialPayload,
    Target,
    UpdateLightsPacket,
    UpdateLightsPayload,
)


class LightingTech:
    name = "LightingTech"
    actions = ("update_lights", "set_material")

    def build(self, intent: Intent) -> list[CommandPacket]:
        if intent.action == "update_lights":
            ambient = None
            if intent.ambient_color is not None or intent.ambient_intensity is not None:
                ambient = AmbientLightPatch(
                    color=intent.ambient_color, intensity=intent.ambient_intensity
                )
            key = None
            if (
                intent.key_color is not None
                or intent.key_intensity is not None
                or intent.key_position is not None
            ):
                key = KeyLightPatch(
                    color=intent.key_color,
                    intensity=intent.key_intensity,
                    position=intent.key_position,
                )
            if ambient is None and key is None and intent.background is None:
                return []
            return [
                UpdateLightsPacket(
                    payload=UpdateLightsPayload(
                        ambient=ambient, key=key, background=intent.background
                    ),
                    transition=intent.transition,
                )
            ]
        if intent.action == "set_material":
            if not intent.target:
                return []
            payload = SetMaterialPayload(
                target=Target(name=intent.target),
                color=intent.color,
                emissive=intent.emissive,
                emissiveIntensity=intent.emissive_intensity,
                opacity=intent.opacity,
            )
            return [SetMaterialPacket(payload=payload)]
        return []
