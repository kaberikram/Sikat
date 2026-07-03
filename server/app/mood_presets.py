"""Scene mood macro presets expanded by the Producer."""
from __future__ import annotations

from .schema import CommandPacket, UpdateFxPacket, UpdateLightsPacket, UpdateLightsPayload

MOOD_PRESETS: dict[str, list[dict]] = {
    "noir": [
        {
            "command": "UPDATE_LIGHTS",
            "payload": {
                "ambient": {"color": "#9aa0b4", "intensity": 0.25},
                "key": {"color": "#dfe6ff", "intensity": 2.4, "position": (6, 9, 3)},
                "background": "#14161d",
            },
        },
        {"command": "UPDATE_FX", "payload": {"section": "dither", "patch": {"enabled": True, "monochrome": True, "strength": 0.8}}},
        {"command": "UPDATE_FX", "payload": {"section": "bloom", "patch": {"enabled": False}}},
    ],
    "sunset": [
        {
            "command": "UPDATE_LIGHTS",
            "payload": {
                "ambient": {"color": "#ffb27a", "intensity": 0.55},
                "key": {"color": "#ff6b35", "intensity": 1.9, "position": (-6, 3, 5)},
                "background": "#ffd9a0",
            },
        },
        {"command": "UPDATE_FX", "payload": {"section": "bloom", "patch": {"enabled": True, "strength": 1.2, "threshold": 0.3}}},
        {"command": "UPDATE_FX", "payload": {"section": "dither", "patch": {"enabled": False}}},
    ],
    "neon": [
        {
            "command": "UPDATE_LIGHTS",
            "payload": {
                "ambient": {"color": "#7b5cff", "intensity": 0.5},
                "key": {"color": "#00ffe1", "intensity": 2.2, "position": (4, 8, 6)},
                "background": "#0b0b17",
            },
        },
        {"command": "UPDATE_FX", "payload": {"section": "bloom", "patch": {"enabled": True, "strength": 1.6, "threshold": 0.15}}},
    ],
    "studio": [
        {
            "command": "UPDATE_LIGHTS",
            "payload": {
                "ambient": {"color": "#ffffff", "intensity": 0.8},
                "key": {"color": "#ffffff", "intensity": 1.5, "position": (5, 10, 7)},
                "background": "#f2f2f2",
            },
        },
        {"command": "UPDATE_FX", "payload": {"section": "bloom", "patch": {"enabled": False}}},
        {"command": "UPDATE_FX", "payload": {"section": "glitch", "patch": {"enabled": False}}},
        {"command": "UPDATE_FX", "payload": {"section": "dither", "patch": {"enabled": False}}},
    ],
}


def mood_packets(mood: str) -> list[CommandPacket]:
    entries = MOOD_PRESETS.get(mood)
    if not entries:
        return []
    packets: list[CommandPacket] = []
    for entry in entries:
        if entry["command"] == "UPDATE_LIGHTS":
            packets.append(
                UpdateLightsPacket(payload=UpdateLightsPayload.model_validate(entry["payload"]))
            )
        else:
            packets.append(UpdateFxPacket(payload=entry["payload"]))
    return packets
