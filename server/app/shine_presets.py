"""Shine: "make it shine" / "product showcase" trailer-beat macro.

Unlike the plain moods in ``mood_presets.py`` (lighting/FX only), shine
expands into a full showcase sequence: pick or spawn a hero object, drop a
title card, apply studio+bloom lighting, frame the camera, animate the
product and title, then play.

This is the deterministic **offline fallback** — when an LLM is configured
the Producer routes showcase requests to the plan loop instead, and the LLM
choreographs a fresh take. Here, per-take variation is seeded from the
command id (same recipe as ``motion_variation``) so even the fallback never
replays the exact same shot twice.
"""
from __future__ import annotations

import math

from . import session_context
from .motion_variation import unit_variation, variation_seed
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

# Motions the fallback rotates through for the hero's product move.
_HERO_MOTIONS = ("turnaround", "orbit", "spin")


def _light_fx_packets(seed: float) -> list[CommandPacket]:
    # Studio-clean lighting punched up with a bloom glow; intensity and bloom
    # strength breathe a little from take to take.
    key_intensity = 1.7 + unit_variation(seed, 11) * 0.6  # 1.7–2.3
    bloom_strength = 1.1 + unit_variation(seed, 12) * 0.6  # 1.1–1.7
    return [
        UpdateLightsPacket(
            payload=UpdateLightsPayload.model_validate(
                {
                    "ambient": {"color": "#ffffff", "intensity": 0.7},
                    "key": {
                        "color": "#eaf6ff",
                        "intensity": round(key_intensity, 2),
                        "position": (5, 10, 6),
                    },
                    "background": "#101018",
                }
            )
        ),
        UpdateFxPacket(
            payload={
                "section": "bloom",
                "patch": {
                    "enabled": True,
                    "strength": round(bloom_strength, 2),
                    "threshold": 0.2,
                    "emissiveBoost": 0.6,
                },
            }
        ),
    ]


def resolve_hero(
    scene: SceneState | None, target: str | None = None
) -> tuple[ObjectSnapshot | None, str]:
    """Returns (existing hero object or None, hero name to use/spawn).

    An explicit ``target`` (e.g. resolved from "shine the blue ball") wins
    over the scene's current selection or the session's last-touched object.
    """
    if target and scene:
        obj = next((o for o in scene.objects if o.name == target), None)
        if obj:
            return obj, obj.name
    if scene and scene.selectedId:
        obj = next((o for o in scene.objects if o.id == scene.selectedId), None)
        if obj:
            return obj, obj.name
    session_target = session_context.last_target()
    if session_target and scene:
        obj = next((o for o in scene.objects if o.name == session_target), None)
        if obj:
            return obj, obj.name
    return None, HERO_SPAWN_NAME


def _hero_position(hero: ObjectSnapshot | None) -> Vec3:
    if hero is None:
        return (0.0, 0.0, 0.0)
    return hero.sampled.position


def shine_packets(
    scene: SceneState | None,
    target: str | None = None,
    command_id: str | None = None,
) -> list[CommandPacket]:
    hero, hero_name = resolve_hero(scene, target)
    hero_pos = _hero_position(hero)
    seed = variation_seed(command_id)

    packets: list[CommandPacket] = []

    if hero is None:
        packets.append(
            SpawnObjectPacket(
                payload=SpawnObjectPayload(primitive="sphere", name=hero_name)
            )
        )

    title_lift = 2.0 + unit_variation(seed, 1)  # 2.0–3.0
    title_pos: Vec3 = (hero_pos[0], hero_pos[1] + round(title_lift, 2), hero_pos[2])
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

    packets.extend(_light_fx_packets(seed))

    azimuth = unit_variation(seed, 2) * math.tau
    camera_distance = 5.0 + unit_variation(seed, 3) * 3.0  # 5–8
    height_factor = 0.3 + unit_variation(seed, 4) * 0.3  # 0.3–0.6
    fov = 28.0 + unit_variation(seed, 5) * 12.0  # 28–40
    camera_pos: Vec3 = (
        round(hero_pos[0] + camera_distance * math.cos(azimuth), 2),
        round(hero_pos[1] + camera_distance * height_factor, 2),
        round(hero_pos[2] + camera_distance * math.sin(azimuth), 2),
    )
    packets.append(
        MoveCameraPacket(
            payload=MoveCameraPayload(
                position=camera_pos,
                lookAtTarget=Target(name=hero_name),
                fov=round(fov, 1),
            ),
            transition=Transition(durationSec=1.2, easing="easeOut"),
        )
    )

    hero_motion = _HERO_MOTIONS[int(unit_variation(seed, 6) * len(_HERO_MOTIONS)) % len(_HERO_MOTIONS)]
    hero_params: dict[str, float] = {"turns": round(1.0 + unit_variation(seed, 7), 2)}
    if hero_motion == "orbit":
        hero_params = {"radius": round(1.0 + unit_variation(seed, 7) * 1.5, 2)}
    packets.append(
        AnimateObjectPacket(
            payload=AnimateObjectPayload(
                target=Target(name=hero_name),
                motion=hero_motion,
                params=hero_params,
                repeat=True,
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
