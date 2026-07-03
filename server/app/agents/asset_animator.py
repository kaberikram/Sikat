"""Asset Animator: objects, transforms, presets, and camera moves."""
from __future__ import annotations

from ..schema import (
    AnimateObjectPacket,
    AnimateObjectPayload,
    CommandPacket,
    Intent,
    MoveCameraPacket,
    MoveCameraPayload,
    RemoveObjectPacket,
    RemoveObjectPayload,
    SpawnObjectPacket,
    SpawnObjectPayload,
    Target,
    TransformObjectPacket,
    TransformObjectPayload,
    Transition,
)


class AssetAnimator:
    name = "AssetAnimator"
    actions = ("spawn", "remove", "transform", "animate", "move_camera")

    def build(self, intent: Intent) -> list[CommandPacket]:
        if intent.action == "spawn":
            return [
                SpawnObjectPacket(
                    payload=SpawnObjectPayload(
                        primitive=intent.primitive or "box",
                        name=intent.name,
                        color=intent.color,
                        text=intent.text,
                        position=intent.position,
                        rotation=intent.rotation,
                        scale=intent.scale,
                    )
                )
            ]
        if intent.action == "remove":
            if not intent.target:
                return []
            return [
                RemoveObjectPacket(
                    payload=RemoveObjectPayload(target=Target(name=intent.target))
                )
            ]
        if intent.action == "transform":
            if not intent.target:
                return []
            return [
                TransformObjectPacket(
                    payload=TransformObjectPayload(
                        target=Target(name=intent.target),
                        mode=intent.mode or "absolute",
                        position=intent.position,
                        rotation=intent.rotation,
                        scale=intent.scale,
                    ),
                    transition=intent.transition,
                )
            ]
        if intent.action == "animate":
            if not intent.target or not intent.preset:
                return []
            return [
                AnimateObjectPacket(
                    payload=AnimateObjectPayload(
                        target=Target(name=intent.target),
                        preset=intent.preset,
                        durationSec=intent.transition.durationSec
                        if intent.transition
                        else None,
                    )
                )
            ]
        if intent.action == "move_camera":
            payload = MoveCameraPayload(
                position=intent.position,
                rotation=intent.rotation,
                lookAtTarget=Target(name=intent.look_at) if intent.look_at else None,
                fov=intent.fov,
            )
            if payload.model_dump(exclude_none=True) == {}:
                return []
            return [
                MoveCameraPacket(
                    payload=payload,
                    transition=intent.transition or Transition(durationSec=1.5),
                )
            ]
        return []
