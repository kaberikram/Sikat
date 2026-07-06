"""Deterministic scene observation detectors for proactive crew."""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from .schema import ObjectSnapshot, SceneState, SampledTransform

SELF_EDIT_SUPPRESS_SEC = 3.0


@dataclass
class Observation:
    kind: str
    agent: str
    subject_object: str | None
    severity: int
    template_line: str
    suggested_command: str | None
    dedupe_key: str


@dataclass
class ManualEdit:
    category: str
    target: str | None
    detail: str


@dataclass
class ObserverMemory:
    was_rolling: bool = False
    was_playing: bool = False
    record_start_camera: SampledTransform | None = None
    known_object_ids: set[str] = field(default_factory=set)
    fired: dict[str, bool] = field(default_factory=dict)
    camera_has_keyframes: bool = False


# Per-agent template pools (keyless fallback)
TEMPLATE_POOLS: dict[str, list[str]] = {
    "VFXOperator": [
        "Bloom's eating the emissive — dial it back?",
        "That's a washout waiting to happen.",
        "Emissive plus heavy bloom — want me to tame it?",
    ],
    "LightingTech": [
        "Key's barely there — hard to read the material.",
        "Painting in the dark over here.",
        "Need more key to see what you changed.",
    ],
    "AssetAnimator": [
        "{name} wandered off the stage.",
        "{name} is overlapping something.",
        "Nothing's choreographed yet — want motion?",
        "Manual tweak on {name} — saw that.",
    ],
    "Producer": [
        "Static take — camera never moved.",
        "That cut's a locked-off shot.",
    ],
}


def _xz_dist(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    return math.hypot(a[0] - b[0], a[2] - b[2])


def _object_radius(obj: ObjectSnapshot) -> float:
    sx, _, sz = obj.sampled.scale
    return max(sx, sz) * 0.5


def _emissive_intensity(obj: ObjectSnapshot) -> float:
    if obj.materialOverride and obj.materialOverride.emissiveIntensity is not None:
        return obj.materialOverride.emissiveIntensity
    return 0.0


def _bloom_enabled(scene: SceneState) -> bool:
    fx = scene.virtualCamera.fx
    return "bloom" in fx.enabledSections


def _bloom_strength(scene: SceneState) -> float:
    fx = scene.virtualCamera.fx
    return fx.bloomStrength if fx.bloomStrength is not None else 0.0


def _camera_pose_changed(a: SampledTransform | None, b: SampledTransform | None) -> bool:
    if a is None or b is None:
        return True
    eps = 0.01
    for av, bv in zip(a.position, b.position, strict=True):
        if abs(av - bv) > eps:
            return True
    for av, bv in zip(a.rotation, b.rotation, strict=True):
        if abs(av - bv) > eps:
            return True
    return False


def update_memory(prev: SceneState | None, curr: SceneState, memory: ObserverMemory) -> None:
    """Edge trackers and record-start pose."""
    if curr.isRolling and not memory.was_rolling:
        memory.record_start_camera = curr.virtualCamera.sampled.model_copy()
    if not curr.isRolling:
        memory.record_start_camera = None

    memory.was_rolling = curr.isRolling
    memory.was_playing = curr.isPlaying
    memory.camera_has_keyframes = bool(curr.virtualCamera.keyframedProperties)
    memory.known_object_ids = {o.id for o in curr.objects}


def run_detectors(
    prev: SceneState | None,
    curr: SceneState,
    memory: ObserverMemory,
) -> list[Observation]:
    if prev is None:
        update_memory(None, curr, memory)
        return []

    observations: list[Observation] = []
    observations.extend(_detect_static_take(prev, curr, memory))
    update_memory(prev, curr, memory)

    observations.extend(_detect_bloom_washout(curr))
    observations.extend(_detect_painting_in_the_dark(prev, curr))
    observations.extend(_detect_off_stage(curr))
    observations.extend(_detect_spawn_overlap(prev, curr, memory))
    observations.extend(_detect_nothing_choreographed(prev, curr))

    return observations


def _detect_bloom_washout(curr: SceneState) -> list[Observation]:
    if not _bloom_enabled(curr) or _bloom_strength(curr) < 1.2:
        return []
    hot = [o for o in curr.objects if _emissive_intensity(o) >= 2.0]
    if not hot:
        return []
    name = hot[0].name
    return [
        Observation(
            kind="bloom_washout",
            agent="VFXOperator",
            subject_object=name,
            severity=3,
            template_line=TEMPLATE_POOLS["VFXOperator"][0],
            suggested_command="set bloom strength to 0.6",
            dedupe_key="bloom_washout",
        )
    ]


def _detect_painting_in_the_dark(prev: SceneState, curr: SceneState) -> list[Observation]:
    key_i = curr.lighting.key.intensity
    amb_i = curr.lighting.ambient.intensity
    if key_i > 0.15 or amb_i > 0.25:
        return []
    material_changed = _any_material_change(prev, curr)
    if not material_changed:
        return []
    return [
        Observation(
            kind="painting_in_the_dark",
            agent="LightingTech",
            subject_object=None,
            severity=2,
            template_line=TEMPLATE_POOLS["LightingTech"][0],
            suggested_command="key light intensity 1.5",
            dedupe_key="painting_in_the_dark",
        )
    ]


def _any_material_change(prev: SceneState, curr: SceneState) -> bool:
    prev_map = {o.id: o.materialOverride for o in prev.objects}
    for obj in curr.objects:
        if prev_map.get(obj.id) != obj.materialOverride:
            return True
    return False


def _detect_off_stage(curr: SceneState) -> list[Observation]:
    radius = curr.stage.radius * 1.05
    center = curr.stage.position
    out: list[Observation] = []
    for obj in curr.objects:
        pos = obj.sampled.position
        if _xz_dist(pos, center) > radius:
            out.append(
                Observation(
                    kind="off_stage",
                    agent="AssetAnimator",
                    subject_object=obj.name,
                    severity=4,
                    template_line=TEMPLATE_POOLS["AssetAnimator"][0].format(name=obj.name),
                    suggested_command=f"move {obj.name} to center",
                    dedupe_key=f"off_stage:{obj.id}",
                )
            )
    return out


def _detect_spawn_overlap(
    prev: SceneState, curr: SceneState, memory: ObserverMemory
) -> list[Observation]:
    prev_ids = {o.id for o in prev.objects}
    new_objs = [o for o in curr.objects if o.id not in prev_ids and o.id not in memory.known_object_ids]
    if not new_objs:
        return []
    out: list[Observation] = []
    for new_obj in new_objs:
        for other in curr.objects:
            if other.id == new_obj.id:
                continue
            dist = _xz_dist(new_obj.sampled.position, other.sampled.position)
            combined = _object_radius(new_obj) + _object_radius(other)
            if dist < combined:
                out.append(
                    Observation(
                        kind="spawn_overlap",
                        agent="AssetAnimator",
                        subject_object=new_obj.name,
                        severity=3,
                        template_line=TEMPLATE_POOLS["AssetAnimator"][1],
                        suggested_command=f"move {new_obj.name} left 2",
                        dedupe_key=f"spawn_overlap:{new_obj.id}:{other.id}",
                    )
                )
                break
    return out


def _detect_static_take(
    prev: SceneState, curr: SceneState, memory: ObserverMemory
) -> list[Observation]:
    if not (prev.isRolling and not curr.isRolling):
        return []
    if memory.camera_has_keyframes:
        return []
    start = memory.record_start_camera
    end = curr.virtualCamera.sampled
    if _camera_pose_changed(start, end):
        return []
    return [
        Observation(
            kind="static_take",
            agent="Producer",
            subject_object=None,
            severity=2,
            template_line=TEMPLATE_POOLS["Producer"][0],
            suggested_command="slow push in over 4 seconds",
            dedupe_key="static_take",
        )
    ]


def _detect_nothing_choreographed(prev: SceneState, curr: SceneState) -> list[Observation]:
    if not (not prev.isPlaying and curr.isPlaying):
        return []
    animated = [o for o in curr.objects if o.keyframedProperties]
    if animated:
        return []
    name = curr.objects[0].name if curr.objects else "the object"
    return [
        Observation(
            kind="nothing_choreographed",
            agent="AssetAnimator",
            subject_object=name,
            severity=1,
            template_line=TEMPLATE_POOLS["AssetAnimator"][2],
            suggested_command=f"make {name} wander the stage",
            dedupe_key="nothing_choreographed",
        )
    ]


def diff_scene(
    prev: SceneState | None,
    curr: SceneState,
    recent_server_edits: dict[str, float],
    *,
    now: float,
) -> list[ManualEdit]:
    if prev is None:
        return []
    edits: list[ManualEdit] = []
    prev_map = {o.id: o for o in prev.objects}

    for obj in curr.objects:
        prev_obj = prev_map.get(obj.id)
        if prev_obj is None:
            continue
        if _position_changed(prev_obj, obj):
            key = f"TRANSFORM_OBJECT:{obj.name}"
            if _is_self_edit(key, recent_server_edits, now):
                continue
            edits.append(ManualEdit("position", obj.name, "position changed"))
        if prev_obj.materialOverride != obj.materialOverride:
            key = f"SET_MATERIAL:{obj.name}"
            if _is_self_edit(key, recent_server_edits, now):
                continue
            edits.append(ManualEdit("material", obj.name, "material changed"))

    if _lighting_changed(prev, curr):
        if not _is_self_edit("UPDATE_LIGHTS", recent_server_edits, now):
            edits.append(ManualEdit("lighting", None, "lighting changed"))

    if _fx_changed(prev, curr):
        if not _is_self_edit("UPDATE_FX", recent_server_edits, now):
            edits.append(ManualEdit("fx", None, "fx changed"))

    return edits


def _is_self_edit(key: str, recent: dict[str, float], now: float) -> bool:
    t = recent.get(key)
    return t is not None and (now - t) < SELF_EDIT_SUPPRESS_SEC


def _position_changed(a: ObjectSnapshot, b: ObjectSnapshot) -> bool:
    eps = 0.001
    for av, bv in zip(a.sampled.position, b.sampled.position, strict=True):
        if abs(av - bv) > eps:
            return True
    return False


def _lighting_changed(prev: SceneState, curr: SceneState) -> bool:
    return (
        prev.lighting.key.intensity != curr.lighting.key.intensity
        or prev.lighting.ambient.intensity != curr.lighting.ambient.intensity
        or prev.lighting.key.color != curr.lighting.key.color
        or prev.lighting.ambient.color != curr.lighting.ambient.color
    )


def _fx_changed(prev: SceneState, curr: SceneState) -> bool:
    pf, cf = prev.virtualCamera.fx, curr.virtualCamera.fx
    return pf.enabledSections != cf.enabledSections or pf.bloomStrength != cf.bloomStrength


def manual_edit_observation(edit: ManualEdit) -> Observation:
    name = edit.target or "the scene"
    return Observation(
        kind="manual_edit",
        agent="AssetAnimator",
        subject_object=edit.target,
        severity=1,
        template_line=TEMPLATE_POOLS["AssetAnimator"][3].format(name=name),
        suggested_command=None,
        dedupe_key=f"manual_edit:{edit.category}:{edit.target or 'global'}",
    )
