"""Tests for proactive crew heuristics and scene diff."""
from __future__ import annotations

import time

from app.heuristics import (
    ObserverMemory,
    diff_scene,
    manual_edit_observation,
    run_detectors,
)
from app.schema import (
    AmbientLightPatch,
    FxSummary,
    KeyLightPatch,
    MaterialOverrideSnapshot,
    ObjectSnapshot,
    SampledTransform,
    SceneLightingSnapshot,
    VirtualCameraSnapshot,
)
from tests.helpers import scene_kw, scene_with


def _obj(
    name: str,
    *,
    oid: str | None = None,
    pos: tuple[float, float, float] = (0.0, 0.0, 0.0),
    emissive_intensity: float | None = None,
    keyframed: list[str] | None = None,
) -> ObjectSnapshot:
    mat = (
        MaterialOverrideSnapshot(emissiveIntensity=emissive_intensity)
        if emissive_intensity is not None
        else None
    )
    return ObjectSnapshot(
        id=oid or f"id_{name}",
        name=name,
        sampled=SampledTransform(position=pos, rotation=(0, 0, 0), scale=(1, 1, 1)),
        materialOverride=mat,
        keyframedProperties=keyframed or [],
    )


def test_bloom_washout_detector():
    mem = ObserverMemory()
    prev = scene_kw(
        virtualCamera=VirtualCameraSnapshot(
            fx=FxSummary(enabledSections=["bloom"], bloomStrength=1.5),
        ),
        objects=[_obj("BOX", emissive_intensity=3.0)],
    )
    curr = prev.model_copy(deep=True)
    obs = run_detectors(prev, curr, mem)
    kinds = [o.kind for o in obs]
    assert "bloom_washout" in kinds
    washout = next(o for o in obs if o.kind == "bloom_washout")
    assert washout.agent == "VFXOperator"
    assert washout.suggested_command == "set bloom strength to 0.6"


def test_off_stage_detector():
    mem = ObserverMemory()
    prev = scene_with("BOX")
    prev.objects[0].sampled.position = (0.0, 0.0, 0.0)
    curr = prev.model_copy(deep=True)
    curr.objects[0].sampled.position = (30.0, 0.0, 30.0)
    obs = run_detectors(prev, curr, mem)
    assert any(o.kind == "off_stage" for o in obs)


def test_static_take_detector():
    mem = ObserverMemory()
    prev = scene_kw(isRolling=True)
    curr = scene_kw(isRolling=False)
    mem.was_rolling = True
    mem.record_start_camera = curr.virtualCamera.sampled.model_copy()
    obs = run_detectors(prev, curr, mem)
    assert any(o.kind == "static_take" for o in obs)


def test_nothing_choreographed_detector():
    mem = ObserverMemory()
    prev = scene_kw(isPlaying=False, objects=[_obj("SPHERE")])
    curr = scene_kw(isPlaying=True, objects=[_obj("SPHERE")])
    mem.was_playing = False
    obs = run_detectors(prev, curr, mem)
    assert any(o.kind == "nothing_choreographed" for o in obs)


def test_painting_in_the_dark():
    mem = ObserverMemory()
    dark_light = SceneLightingSnapshot(
        ambient=AmbientLightPatch(color="#ffffff", intensity=0.1),
        key=KeyLightPatch(color="#ffffff", intensity=0.1, position=(10, 20, 10)),
        background="#000000",
    )
    prev = scene_kw(lighting=dark_light, objects=[_obj("BOX")])
    curr = prev.model_copy(deep=True)
    curr.objects[0].materialOverride = MaterialOverrideSnapshot(color="#ff0000")
    obs = run_detectors(prev, curr, mem)
    assert any(o.kind == "painting_in_the_dark" for o in obs)


def test_diff_scene_suppresses_self_edit():
    prev = scene_with("BOX")
    curr = prev.model_copy(deep=True)
    curr.objects[0].sampled.position = (1.0, 0.0, 0.0)
    now = time.monotonic()
    recent = {f"TRANSFORM_OBJECT:BOX": now - 1.0}
    edits = diff_scene(prev, curr, recent, now=now)
    assert edits == []


def test_diff_scene_detects_manual_edit():
    prev = scene_with("BOX")
    curr = prev.model_copy(deep=True)
    curr.objects[0].sampled.position = (1.0, 0.0, 0.0)
    edits = diff_scene(prev, curr, {}, now=time.monotonic())
    assert len(edits) == 1
    assert edits[0].category == "position"


def test_manual_edit_observation():
    from app.heuristics import ManualEdit

    obs = manual_edit_observation(ManualEdit("position", "BOX", "position changed"))
    assert obs.suggested_command is None
    assert "BOX" in obs.template_line
