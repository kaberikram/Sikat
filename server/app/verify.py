"""Post-apply verification — deterministic correction after transform/keyframe packets."""
from __future__ import annotations

import math
import os
from dataclasses import dataclass

from .schema import (
    CommandPacket,
    Intent,
    SceneState,
    Target,
    TransformObjectPacket,
    TransformObjectPayload,
    Vec3,
)

FLOOR_Y = 0.0
POSITION_MISS_RATIO = 0.20
CROWDING_RATIO = 0.6
"""How far inside each other two footprints must be to count as a collision.

Props on a shared surface are meant to sit close, so touching is not a fault —
only real interpenetration is."""


@dataclass
class Correction:
    message: str
    packet: TransformObjectPacket


def verify_enabled() -> bool:
    return os.getenv("DIRECTOR_VERIFY", "1") not in ("0", "false", "False", "no")


def check_apply(
    intent: Intent | None,
    packet: CommandPacket,
    scene: SceneState | None,
) -> Correction | None:
    if scene is None:
        return None
    if packet.command == "TRANSFORM_OBJECT":
        return _check_transform(packet, scene) or _check_crowding(packet, scene)
    if packet.command == "SET_KEYFRAMES":
        return _check_keyframes(intent, packet, scene)
    return None


def _check_crowding(packet: CommandPacket, scene: SceneState) -> Correction | None:
    """Push a prop off one it has landed inside.

    The offsets that space a group across a surface are computed from bounds
    measured before the move, so a prop that pops in mid-flight, or a surface
    smaller than the group needs, can still end up overlapping. Cheaper to
    notice afterwards and nudge than to model perfectly up front.
    """
    target_name = packet.payload.target.name
    if not target_name:
        return None
    mover = next((o for o in scene.objects if o.name == target_name), None)
    if mover is None or mover.bounds is None:
        return None
    mine = _footprint(mover.bounds)
    mx, _, mz = mover.sampled.position

    for other in scene.objects:
        if other.name == target_name or other.bounds is None:
            continue
        ox, _, oz = other.sampled.position
        theirs = _footprint(other.bounds)
        gap = math.hypot(mx - ox, mz - oz)
        clearance = mine + theirs
        # Only genuine interpenetration, not a close-but-deliberate arrangement.
        if gap >= clearance * CROWDING_RATIO or clearance <= 0:
            continue
        if gap < 1e-4:
            dx, dz = 1.0, 0.0
        else:
            dx, dz = (mx - ox) / gap, (mz - oz) / gap
        push = clearance - gap
        return _correction(
            target_name,
            (mx + dx * push, mover.sampled.position[1], mz + dz * push),
            packet,
            f"{target_name} landed inside {other.name} — spacing them out",
        )
    return None


def _footprint(bounds) -> float:
    sx = bounds.max[0] - bounds.min[0]
    sz = bounds.max[2] - bounds.min[2]
    return max(sx, sz) / 2


def _check_transform(packet: TransformObjectPacket, scene: SceneState) -> Correction | None:
    payload = packet.payload
    if payload.mode != "absolute" or not payload.position:
        return None
    target_name = payload.target.name
    if not target_name:
        return None
    obj = next((o for o in scene.objects if o.name == target_name), None)
    if obj is None:
        return None
    intended = payload.position
    actual = obj.sampled.position
    if _below_floor(actual):
        return _correction(
            target_name,
            (actual[0], max(FLOOR_Y + 0.05, intended[1]), actual[2]),
            packet,
            "that clipped the floor — nudging up",
        )
    if _off_stage(actual, scene):
        center = scene.stage.position
        return _correction(
            target_name,
            (center[0], actual[1], center[2]),
            packet,
            "that landed off stage — nudging to center",
        )
    if _positional_miss(intended, actual):
        return _correction(target_name, intended, packet, "nudging to intended position")
    return None


def _check_keyframes(intent: Intent | None, packet: CommandPacket, scene: SceneState) -> Correction | None:
    if intent is None or not intent.target:
        return None
    obj = next((o for o in scene.objects if o.name == intent.target), None)
    if obj is None:
        return None
    actual = obj.sampled.position
    if _below_floor(actual):
        return _correction(
            intent.target,
            (actual[0], FLOOR_Y + 0.05, actual[2]),
            packet,
            "keyframes clipped the floor — nudging up",
        )
    return None


def _below_floor(pos: Vec3) -> bool:
    return pos[1] < FLOOR_Y


def _off_stage(pos: Vec3, scene: SceneState) -> bool:
    center = scene.stage.position
    dist = math.hypot(pos[0] - center[0], pos[2] - center[2])
    return dist > scene.stage.radius * 1.05


def _positional_miss(intended: Vec3, actual: Vec3) -> bool:
    span = max(abs(intended[0]) + abs(intended[2]), 1.0)
    err = math.hypot(intended[0] - actual[0], intended[2] - actual[2])
    return err / span > POSITION_MISS_RATIO


def _correction(
    name: str,
    position: Vec3,
    prior: CommandPacket,
    message: str,
) -> Correction:
    packet = TransformObjectPacket(
        commandId=prior.commandId,
        priorCommandId=prior.commandId,
        refinement=True,
        payload=TransformObjectPayload(
            target=Target(name=name),
            mode="absolute",
            position=position,
        ),
    )
    return Correction(message=message, packet=packet)
