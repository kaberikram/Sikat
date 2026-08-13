"""Fallback motion generator when the plan loop produces no packets.

When an action-seeking utterance reaches the plan loop but no executable
steps survive (malformed JSON, truncated streams, LLM confusion), this
module provides a guaranteed-animation safety net instead of silence.
Open briefs get a unique seeded keyframe path (SET_KEYFRAMES), not a
catalog bounce/float/orbit. Literal craft verbs still use motion ids.
"""
from __future__ import annotations

import math
import re

from . import session_context
from .creative_parse import catalog_motion_forbidden, said_literal_motion
from .motion_variation import enrich_motion_params, unit_variation, variation_seed
from .schema import (
    AnimateObjectPacket,
    AnimateObjectPayload,
    CommandPacket,
    Keyframe,
    PlaybackPacket,
    PlaybackPayload,
    SceneState,
    SetKeyframesPacket,
    SetKeyframesPayload,
    SpawnObjectPacket,
    SpawnObjectPayload,
    Target,
    Vec3,
)
from .shine_presets import resolve_hero

_FALLBACK_MOTIONS = ("float", "bounce", "orbit", "wander", "figure8")

_ANIMATION_SEEKING = re.compile(
    r"\b(?:animate|animation|bounce|float|wander|orbit|spin|sway|drop|rise|"
    r"dance|move|surprise|choreograph|crazy)\b",
    re.I,
)

_PATH_TIMES = (0.0, 0.5, 1.1, 1.9, 2.8, 3.9, 5.0, 6.0)


def is_animation_seeking(text: str) -> bool:
    return bool(_ANIMATION_SEEKING.search(text))


def _stable_seed(text: str) -> int:
    h = 2166136261
    for ch in text:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def _clamp_to_stage(x: float, y: float, z: float, center: Vec3, radius: float) -> Vec3:
    dx = x - center[0]
    dz = z - center[2]
    dist = math.hypot(dx, dz)
    max_r = max(0.05, radius * 0.85)
    if dist > max_r and dist > 0:
        scale = max_r / dist
        x = center[0] + dx * scale
        z = center[2] + dz * scale
    return (x, max(0.02, y), z)


def authored_path_keyframes(
    base: Vec3,
    seed: float,
    stage_center: Vec3,
    stage_radius: float,
) -> list[Keyframe]:
    """8 world-space poses around BASE — unique per seed, inside the stage."""
    travel = min(0.35 * stage_radius, 0.45)
    keys: list[Keyframe] = []
    for i, t in enumerate(_PATH_TIMES):
        u = unit_variation(seed, i + 10)
        v = unit_variation(seed, i + 20)
        angle = (i / 7.0) * math.tau + u * 0.8
        lift = (v - 0.5) * travel * 0.8
        x = base[0] + math.cos(angle) * travel * (0.6 + u * 0.5)
        y = base[1] + lift + travel * 0.15
        z = base[2] + math.sin(angle) * travel * (0.6 + v * 0.5)
        x, y, z = _clamp_to_stage(x, y, z, stage_center, stage_radius)
        keys.append(Keyframe(time=t, value=(round(x, 3), round(y, 3), round(z, 3))))
    keys[-1] = Keyframe(time=_PATH_TIMES[-1], value=keys[0].value)
    return keys


def motion_floor_packets(
    text: str,
    command_id: str | None,
    scene: SceneState | None = None,
) -> list[CommandPacket]:
    """Guaranteed animation packets when the plan loop produces nothing.

    Open briefs emit SET_KEYFRAMES + PLAYBACK (a seeded path around the hero).
    Literal craft verbs still emit ANIMATE_OBJECT from the catalog.

    `resolve_hero` returns a two-part contract: a `None` object means the name
    is one to **spawn**. This used to take the name and animate it regardless,
    so on any set where nothing was selected or touched — which in XR is every
    set, since selection is a desktop-gizmo concept — it emitted an
    ANIMATE_OBJECT against a `HERO_SPHERE` that nothing had created, and the
    client failed it. `shine_packets` has always honoured both halves; this now
    matches it.

    `scene` is the caller's live snapshot. Falling back to
    `session.latest_scene` reads the 300ms heartbeat, which lags the command's
    own full snapshot.
    """
    session = session_context.get_session()
    live = scene or session.latest_scene
    hero_obj, hero_name = resolve_hero(live, target=None)
    packets: list[CommandPacket] = []
    if hero_obj is None:
        packets.append(
            SpawnObjectPacket(
                payload=SpawnObjectPayload(primitive="sphere", name=hero_name)
            )
        )

    wants_keys = catalog_motion_forbidden(text) or (
        is_animation_seeking(text) and not said_literal_motion(text)
    )
    if wants_keys:
        stage = live.stage if live else None
        center: Vec3 = stage.position if stage else (0.0, 0.0, 0.0)
        radius = stage.radius if stage else 1.0
        base: Vec3 = hero_obj.position if hero_obj is not None else (0.0, 0.15, 0.0)
        seed = float(_stable_seed(f"{text}:{command_id or ''}"))
        packets.append(
            SetKeyframesPacket(
                payload=SetKeyframesPayload(
                    target=Target(name=hero_name),
                    property="position",
                    keyframes=authored_path_keyframes(base, seed, center, radius),
                )
            )
        )
        packets.append(PlaybackPacket(payload=PlaybackPayload(action="play")))
        return packets

    seed = variation_seed(command_id)
    motion_idx = abs(hash(command_id or "sikat")) % len(_FALLBACK_MOTIONS)
    motion = _FALLBACK_MOTIONS[motion_idx]
    params = enrich_motion_params(None, motion, command_id)
    packets.append(
        AnimateObjectPacket(
            payload=AnimateObjectPayload(
                target=Target(name=hero_name),
                motion=motion,
                params=params,
            )
        )
    )
    packets.append(PlaybackPacket(payload=PlaybackPayload(action="play")))
    return packets
