"""Default motion transitions for object/light/material commands."""
from __future__ import annotations

import math

from .schema import SceneState, Transition, Vec3

_MIN_DURATION = 0.6
_MAX_DURATION = 0.9
_BASE_DURATION = 0.25
_DISTANCE_SCALE = 0.08


def _vec3_magnitude(v: Vec3) -> float:
    return math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)


def _object_position(scene: SceneState | None, target_name: str | None) -> Vec3 | None:
    if scene is None or not target_name:
        return None
    needle = target_name.lower()
    for obj in scene.objects:
        if obj.name.lower() == needle or needle in obj.name.lower():
            return obj.sampled.position
    return None


def _move_distance(
    scene: SceneState | None,
    target_name: str | None,
    delta: Vec3 | None,
    mode: str,
    absolute_to: Vec3 | None = None,
) -> float:
    if mode == "relative" and delta is not None:
        return _vec3_magnitude(delta)
    if mode == "absolute" and absolute_to is not None:
        current = _object_position(scene, target_name)
        if current is None:
            return _vec3_magnitude(absolute_to)
        return _vec3_magnitude(
            (
                absolute_to[0] - current[0],
                absolute_to[1] - current[1],
                absolute_to[2] - current[2],
            )
        )
    if delta is not None:
        return _vec3_magnitude(delta)
    return 1.0


def default_object_transition(
    scene: SceneState | None,
    target_name: str | None,
    delta: Vec3 | None,
    mode: str = "relative",
    *,
    absolute_to: Vec3 | None = None,
) -> Transition:
    """Ease-out glide scaled by move distance (~0.6–0.9s)."""
    distance = _move_distance(scene, target_name, delta, mode, absolute_to)
    duration = min(_MAX_DURATION, max(_MIN_DURATION, _BASE_DURATION + distance * _DISTANCE_SCALE))
    return Transition(durationSec=duration, easing="easeOut")


def default_ambient_transition() -> Transition:
    """Non-spatial property change — fixed mid-range duration."""
    return Transition(durationSec=0.75, easing="easeOut")
