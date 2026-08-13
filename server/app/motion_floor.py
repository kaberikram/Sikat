"""Fallback motion generator when the plan loop produces no packets.

When an action-seeking utterance reaches the plan loop but no executable
steps survive (malformed JSON, truncated streams, LLM confusion), this
module provides a guaranteed-animation safety net instead of silence.
"""
from __future__ import annotations

import re

from . import session_context
from .motion_variation import enrich_motion_params, variation_seed
from .schema import (
    AnimateObjectPacket,
    AnimateObjectPayload,
    CommandPacket,
    PlaybackPacket,
    PlaybackPayload,
    SceneState,
    SpawnObjectPacket,
    SpawnObjectPayload,
    Target,
)
from .shine_presets import resolve_hero

_FALLBACK_MOTIONS = ("float", "bounce", "orbit", "wander", "figure8")

_ANIMATION_SEEKING = re.compile(
    r"\b(?:animate|animation|bounce|float|wander|orbit|spin|sway|drop|rise|"
    r"dance|move|surprise|choreograph)\b",
    re.I,
)


def is_animation_seeking(text: str) -> bool:
    return bool(_ANIMATION_SEEKING.search(text))


def motion_floor_packets(
    text: str,
    command_id: str | None,
    scene: SceneState | None = None,
) -> list[CommandPacket]:
    """Guaranteed animation packets when the plan loop produces nothing.

    Picks the hero object from the scene (or a fallback name), seeds
    variation from the command id so the same request never yields the
    exact same shot twice, and emits ANIMATE + PLAYBACK.

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
    hero_obj, hero_name = resolve_hero(scene or session.latest_scene, target=None)
    seed = variation_seed(command_id)
    motion_idx = abs(hash(command_id or "sikat")) % len(_FALLBACK_MOTIONS)
    motion = _FALLBACK_MOTIONS[motion_idx]
    params = enrich_motion_params(None, motion, command_id)

    packets: list[CommandPacket] = []
    if hero_obj is None:
        # Nothing on set to work with — make the subject before directing it.
        packets.append(
            SpawnObjectPacket(
                payload=SpawnObjectPayload(primitive="sphere", name=hero_name)
            )
        )
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
