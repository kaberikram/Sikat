"""Deterministic, journal-backed Director plan inversion."""
from __future__ import annotations

from .schema import (
    CommandPacket,
    MoveCameraPacket,
    MoveCameraPayload,
    RemoveObjectPacket,
    RemoveObjectPayload,
    SetKeyframesPacket,
    SetKeyframesPayload,
    Target,
    TransformObjectPacket,
    TransformObjectPayload,
    UpdateLightsPacket,
    UpdateLightsPayload,
)
from .session_context import PlanJournalEntry


def build_inverse_packets(entry: PlanJournalEntry) -> tuple[list[CommandPacket], list[str]]:
    """Build best-effort inverse packets from a plan's full pre-command scene."""
    scene = entry.pre_scene
    if scene is None:
        return [], ["I need a scene snapshot to roll that back."]
    objects = {obj.name: obj for obj in scene.objects}
    packets: list[CommandPacket] = []
    notes: list[str] = []
    for packet in reversed(entry.packets):
        if packet.command == "SPAWN_OBJECT":
            name = packet.payload.name or packet.payload.id
            if name:
                packets.append(RemoveObjectPacket(payload=RemoveObjectPayload(target=Target(name=name))))
        elif packet.command in ("TRANSFORM_OBJECT", "ANIMATE_OBJECT", "SET_KEYFRAMES"):
            target = getattr(packet.payload, "target", None)
            name = target.name if target else None
            before = objects.get(name or "")
            if before is None:
                continue
            if packet.command == "TRANSFORM_OBJECT":
                packets.append(
                    TransformObjectPacket(
                        payload=TransformObjectPayload(
                            target=Target(name=before.name),
                            mode="absolute",
                            position=before.position,
                            rotation=before.rotation,
                            scale=before.scale,
                        )
                    )
                )
            for track in before.tracks:
                keyframes = getattr(track, "keyframes", [])
                packets.append(
                    SetKeyframesPacket(
                        payload=SetKeyframesPayload(
                            target=Target(name=before.name),
                            property=track.property,
                            keyframes=keyframes,
                        )
                    )
                )
        elif packet.command == "UPDATE_LIGHTS":
            packets.append(
                UpdateLightsPacket(
                    payload=UpdateLightsPayload(
                        ambient=scene.lighting.ambient,
                        key=scene.lighting.key,
                        background=scene.lighting.background,
                    )
                )
            )
        elif packet.command == "MOVE_CAMERA":
            camera = scene.virtualCamera
            packets.append(
                MoveCameraPacket(
                    payload=MoveCameraPayload(
                        position=camera.position, rotation=camera.rotation, fov=camera.fov
                    )
                )
            )
        elif packet.command == "REMOVE_OBJECT":
            notes.append("I can't restore a removed object yet.")
        elif packet.command == "SET_MATERIAL":
            notes.append("Material clears are not reversible yet.")
        elif packet.command == "UPDATE_FX":
            notes.append("FX rollback is limited in this take.")
    return packets, list(dict.fromkeys(notes))
