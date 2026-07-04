"""Shared scene builders for Director Mode server tests."""
from app.schema import (
    KeyframePoint,
    KeyframeTrackFull,
    ObjectSnapshot,
    SampledTransform,
    SceneState,
)


def scene_with(*names: str) -> SceneState:
    return SceneState(
        objects=[
            ObjectSnapshot(id=f"id{i}", name=name) for i, name in enumerate(names)
        ],
    )


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
