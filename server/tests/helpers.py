"""Shared scene builders for Director Mode server tests."""
from app.schema import (
    AmbientLightPatch,
    FxSummary,
    KeyLightPatch,
    KeyframePoint,
    KeyframeTrackFull,
    MaterialOverrideSnapshot,
    ObjectSnapshot,
    SampledTransform,
    SceneLightingSnapshot,
    SceneState,
    StageSnapshot,
    VirtualCameraSnapshot,
)


def scene_with(*names: str) -> SceneState:
    return SceneState(
        objects=[
            ObjectSnapshot(id=f"id{i}", name=name) for i, name in enumerate(names)
        ],
    )


def scene_kw(**overrides) -> SceneState:
    """Compact SceneState builder — pass any SceneState field as kwarg."""
    base = scene_with()
    data = base.model_dump()
    for key, val in overrides.items():
        if key == "objects" and isinstance(val, list):
            data["objects"] = [
                o.model_dump() if isinstance(o, ObjectSnapshot) else o for o in val
            ]
        elif key == "virtualCamera" and isinstance(val, VirtualCameraSnapshot):
            data["virtualCamera"] = val.model_dump()
        elif key == "lighting" and isinstance(val, SceneLightingSnapshot):
            data["lighting"] = val.model_dump()
        elif key == "stage" and isinstance(val, StageSnapshot):
            data["stage"] = val.model_dump()
        else:
            data[key] = val
    return SceneState.model_validate(data)


def animated_sphere_scene() -> SceneState:
    """Sphere with a bounce-like Y position track for describe tests."""
    tracks = [
        KeyframeTrackFull(
            property="position",
            keyframes=[
                KeyframePoint(time=0.0, value=(0.0, 0.0, 0.0)),
                KeyframePoint(time=1.0, value=(0.0, 2.5, 0.0)),
                KeyframePoint(time=2.0, value=(0.0, 0.0, 0.0)),
                KeyframePoint(time=3.0, value=(0.0, 2.5, 0.0)),
                KeyframePoint(time=4.0, value=(0.0, 0.0, 0.0)),
                KeyframePoint(time=5.0, value=(0.0, 2.0, 0.0)),
            ],
        )
    ]
    return SceneState(
        currentTime=2.4,
        duration=10.0,
        isPlaying=True,
        selectedId="id0",
        objects=[
            ObjectSnapshot(
                id="id0",
                name="CORE_SPHERE",
                sampled=SampledTransform(
                    position=(0.0, 1.2, 0.0),
                    rotation=(0.0, 0.0, 0.0),
                    scale=(1.0, 1.0, 1.0),
                ),
                keyframedProperties=["position"],
                tracks=tracks,
            )
        ],
        mode="full",
    )
