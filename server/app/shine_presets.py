"""Shine v1: "make it shine" / "product showcase" trailer-beat macro.

Unlike the plain moods in ``mood_presets.py`` (lighting/FX only), shine
expands into a full showcase sequence: pick or spawn a hero object, drop a
title card, apply studio+bloom lighting, frame the camera, animate the
product and title, then play.
"""
from __future__ import annotations

from . import session_context
from .schema import (
    AnimateObjectPacket,
    AnimateObjectPayload,
    CommandPacket,
    MoveCameraPacket,
    MoveCameraPayload,
    ObjectSnapshot,
    PlaybackPacket,
    PlaybackPayload,
    SceneState,
    SpawnObjectPacket,
    SpawnObjectPayload,
    Target,
    Transition,
    UpdateFxPacket,
    UpdateLightsPacket,
    UpdateLightsPayload,
    Vec3,
)

TITLE_TEXT = "RADIO_EDIT"
HERO_SPAWN_NAME = "HERO_SPHERE"
TITLE_SPAWN_NAME = "SHINE_TITLE"

# Studio-clean lighting punched up with a strong bloom for a product-shot glow.
SHINE_LIGHT_FX: list[dict] = [
    {
        "command": "UPDATE_LIGHTS",
        "payload": {
            "ambient": {"color": "#ffffff", "intensity": 0.7},
            "key": {"color": "#eaf6ff", "intensity": 2.0, "position": (5, 10, 6)},
            "background": "#101018",
        },
    },
    {
        "command": "UPDATE_FX",
        "payload": {
            "section": "bloom",
            "patch": {
                "enabled": True,
                "strength": 1.4,
                "threshold": 0.2,
                "emissiveBoost": 0.6,
            },
        },
    },
]


def _light_fx_packets() -> list[CommandPacket]:
    packets: list[CommandPacket] = []
    for entry in SHINE_LIGHT_FX:
        if entry["command"] == "UPDATE_LIGHTS":
            packets.append(
                UpdateLightsPacket(payload=UpdateLightsPayload.model_validate(entry["payload"]))
            )
        else:
            packets.append(UpdateFxPacket(payload=entry["payload"]))
    return packets


def resolve_hero(scene: SceneState | None) -> tuple[ObjectSnapshot | None, str]:
    """Returns (existing hero object or None, hero name to use/spawn)."""
    if scene and scene.selectedId:
        obj = next((o for o in scene.objects if o.id == scene.selectedId), None)
        if obj:
            return obj, obj.name
    target = session_context.last_target()
    if target and scene:
        obj = next((o for o in scene.objects if o.name == target), None)
        if obj:
            return obj, obj.name
    return None, HERO_SPAWN_NAME


def _hero_position(hero: ObjectSnapshot | None) -> Vec3:
    if hero is None:
        return (0.0, 0.0, 0.0)
    return hero.sampled.position


def shine_packets(scene: SceneState | None) -> list[CommandPacket]:
    hero, hero_name = resolve_hero(scene)
    hero_pos = _hero_position(hero)

    packets: list[CommandPacket] = []

    if hero is None:
        packets.append(
            SpawnObjectPacket(
                payload=SpawnObjectPayload(primitive="sphere", name=hero_name)
            )
        )

    title_pos: Vec3 = (hero_pos[0], hero_pos[1] + 2.4, hero_pos[2])
    packets.append(
        SpawnObjectPacket(
            payload=SpawnObjectPayload(
                primitive="text",
                name=TITLE_SPAWN_NAME,
                text=TITLE_TEXT,
                position=title_pos,
            )
        )
    )

    packets.extend(_light_fx_packets())

    camera_distance = 6.0
    camera_pos: Vec3 = (
        hero_pos[0] + camera_distance * 0.6,
        hero_pos[1] + camera_distance * 0.4,
        hero_pos[2] + camera_distance * 0.9,
    )
    packets.append(
        MoveCameraPacket(
            payload=MoveCameraPayload(
                position=camera_pos,
                lookAtTarget=Target(name=hero_name),
                fov=32.0,
            ),
            transition=Transition(durationSec=1.2, easing="easeOut"),
        )
    )

    packets.append(
        AnimateObjectPacket(
            payload=AnimateObjectPayload(
                target=Target(name=hero_name), motion="turnaround", repeat=True
            )
        )
    )
    packets.append(
        AnimateObjectPacket(
            payload=AnimateObjectPayload(
                target=Target(name=TITLE_SPAWN_NAME), motion="rise", repeat=False
            )
        )
    )
    packets.append(
        AnimateObjectPacket(
            payload=AnimateObjectPayload(
                target=Target(name=TITLE_SPAWN_NAME), motion="pulse", repeat=True
            )
        )
    )

    packets.append(PlaybackPacket(payload=PlaybackPayload(action="play")))

    return packets
