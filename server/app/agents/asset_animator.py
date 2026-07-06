"""Asset Animator: objects, transforms, presets, and camera moves."""
from __future__ import annotations

from ..schema import (
    AnimateObjectPacket,
    AnimateObjectPayload,
    CommandPacket,
    Intent,
    MoveCameraPacket,
    MoveCameraPayload,
    PlaybackPacket,
    PlaybackPayload,
    RemoveObjectPacket,
    RemoveObjectPayload,
    SceneState,
    SetKeyframesPacket,
    SetKeyframesPayload,
    SpawnObjectPacket,
    SpawnObjectPayload,
    Target,
    TransformObjectPacket,
    TransformObjectPayload,
    Transition,
)
from ..transitions import default_object_transition


class AssetAnimator:
    name = "AssetAnimator"
    actions = ("spawn", "remove", "transform", "animate", "move_camera")

    def build(self, intent: Intent, scene: SceneState | None = None) -> list[CommandPacket]:
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
            mode = intent.mode or "absolute"
            transition = intent.transition
            if transition is None and not intent.snap_motion:
                delta = intent.position or intent.rotation or intent.scale
                transition = default_object_transition(
                    scene,
                    intent.target,
                    intent.position if intent.position else delta,
                    mode,
                    absolute_to=intent.position if mode == "absolute" else None,
                )
            return [
                TransformObjectPacket(
                    payload=TransformObjectPayload(
                        target=Target(name=intent.target),
                        mode=mode,
                        position=intent.position,
                        rotation=intent.rotation,
                        scale=intent.scale,
                    ),
                    transition=transition,
                )
            ]
        if intent.action == "animate":
            motion = intent.motion or intent.preset
            if not intent.target:
                return []
            if intent.track_keyframes and intent.track_property:
                packets: list[CommandPacket] = [
                    SetKeyframesPacket(
                        payload=SetKeyframesPayload(
                            target=Target(name=intent.target),
                            property=intent.track_property,
                            keyframes=intent.track_keyframes,
                        )
                    )
                ]
                packets.append(PlaybackPacket(payload=PlaybackPayload(action="play")))
                return packets
            if not motion:
                return []
            return [
                AnimateObjectPacket(
                    payload=AnimateObjectPayload(
                        target=Target(name=intent.target),
                        preset=intent.preset,
                        motion=motion,
                        params=intent.motion_params,
                        durationSec=intent.transition.durationSec
                        if intent.transition
                        else None,
                        repeat=intent.animate_repeat or False,
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
