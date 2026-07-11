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
    text: str, command_id: str | None
) -> list[CommandPacket]:
    """Guaranteed animation packets when the plan loop produces nothing.

    Picks the hero object from the scene (or a fallback name), seeds
    variation from the command id so the same request never yields the
    exact same shot twice, and emits ANIMATE + PLAYBACK.
    """
    session = session_context.get_session()
    hero_obj, hero_name = resolve_hero(
        session.latest_scene, target=None
    )
    seed = variation_seed(command_id)
    motion_idx = abs(hash(command_id or "sikat")) % len(_FALLBACK_MOTIONS)
    motion = _FALLBACK_MOTIONS[motion_idx]
    params = enrich_motion_params(None, motion, command_id)
    return [
        AnimateObjectPacket(
            payload=AnimateObjectPayload(
                target=Target(name=hero_name),
                motion=motion,
                params=params,
            )
        ),
        PlaybackPacket(payload=PlaybackPayload(action="play")),
    ]
