"""Compact scene briefing for LLM system prompt injection."""
from __future__ import annotations

from .spatial import Box, Placed, Relations, describe_scene, forward_from_euler
from .schema import (
    KeyframePoint,
    KeyframeTrackFull,
    KeyframeTrackSummary,
    ObjectSnapshot,
    SceneState,
    VirtualCameraSnapshot,
)

DescribeTopic = str


def _fmt_vec(v: tuple[float, float, float]) -> str:
    return f"({v[0]:g},{v[1]:g},{v[2]:g})"


def _track_keyframes(track: KeyframeTrackSummary | KeyframeTrackFull) -> list[KeyframePoint]:
    if isinstance(track, KeyframeTrackFull):
        return track.keyframes
    return []


def _count_peaks(values: list[float]) -> int:
    if len(values) < 3:
        return 0
    peaks = 0
    for i in range(1, len(values) - 1):
        if values[i] > values[i - 1] and values[i] > values[i + 1]:
            peaks += 1
        elif values[i] < values[i - 1] and values[i] < values[i + 1]:
            peaks += 1
    return peaks


def summarize_track(
    property: str, keyframes: list[KeyframePoint]
) -> str:
    """Human-readable track summary with animation heuristics."""
    count = len(keyframes)
    if count == 0:
        return f"{property}×0"

    sorted_kf = sorted(keyframes, key=lambda k: k.time)
    first = sorted_kf[0].time
    last = sorted_kf[-1].time
    duration = last - first
    base = f"{property}×{count}"

    if count == 1:
        return base

    extras: list[str] = []
    if duration > 0:
        extras.append(f"{first:.1f}–{last:.1f}s")

    if property == "position":
        ys = [k.value[1] for k in sorted_kf]
        y_min, y_max = min(ys), max(ys)
        if y_max - y_min > 0.01:
            extras.append(f"Y range {y_min:g}→{y_max:g}")
        if _count_peaks(ys) >= 2:
            extras.append("bounce-like")
    elif property == "rotation":
        axis_vals = [k.value[1] for k in sorted_kf]
        if all(axis_vals[i] <= axis_vals[i + 1] for i in range(len(axis_vals) - 1)):
            extras.append("spin/turnaround-like")
        elif all(axis_vals[i] >= axis_vals[i + 1] for i in range(len(axis_vals) - 1)):
            extras.append("spin/turnaround-like")

    if extras:
        return f"{base} ({', '.join(extras)})"
    return base


def _format_keyframe_list(keyframes: list[KeyframePoint]) -> str:
    if not keyframes:
        return ""
    sorted_kf = sorted(keyframes, key=lambda k: k.time)
    if len(sorted_kf) <= 20:
        parts = [f"{k.time:g}@{_fmt_vec(k.value)}" for k in sorted_kf]
        return " | ".join(parts)

    head = sorted_kf[:3]
    tail = sorted_kf[-2:]
    parts = [f"{k.time:g}@{_fmt_vec(k.value)}" for k in head]
    parts.append("…")
    parts.extend(f"{k.time:g}@{_fmt_vec(k.value)}" for k in tail)
    parts.append(f"({len(sorted_kf)} total)")
    return " | ".join(parts)


def _format_size(obj: ObjectSnapshot) -> str | None:
    """How much room it takes up, and where its usable surface is.

    `top` is the number the crew could never derive: a scale multiplier against
    an unknown base geometry says nothing about where to put something on it.
    """
    if obj.bounds is None:
        return None
    b = Box(min=tuple(obj.bounds.min), max=tuple(obj.bounds.max))
    sx, sy, sz = b.size
    return (
        f"  size {sx:.2f}×{sy:.2f}×{sz:.2f}  "
        f"top y={b.top:.2f}  base y={b.bottom:.2f}  footprint r={b.footprint_radius:.2f}"
    )


def _format_relations(rel: Relations | None) -> str | None:
    """One line of what a person in the room would notice. Omits what doesn't apply."""
    if rel is None:
        return None
    bits: list[str] = []
    if rel.resting_on:
        bits.append(f"resting on {rel.resting_on}")
    if rel.supporting:
        bits.append(f"supporting {', '.join(rel.supporting)}")
    if rel.near:
        bits.append(f"next to {', '.join(rel.near)}")
    if rel.stage_distance is not None:
        where = "on stage" if rel.on_stage else "OFF STAGE"
        bits.append(f"{rel.stage_distance:.2f}m from stage centre ({where})")
    if rel.camera_distance is not None and rel.camera_bearing:
        bits.append(f"{rel.camera_distance:.2f}m from camera, {rel.camera_bearing}")
    return f"  {' · '.join(bits)}" if bits else None


def _track_window(obj: ObjectSnapshot) -> tuple[float, float] | None:
    """First and last keyframe time across every track, or None if unanimated."""
    times = [k.time for t in obj.tracks for k in _track_keyframes(t)]
    if not times:
        return None
    return min(times), max(times)


def _live_motion_bits(obj: ObjectSnapshot, now_t: float) -> list[str]:
    """Named motion + playhead state — shared by the LIVE MOTION line and object cards."""
    bits: list[str] = []
    if obj.motion:
        named = obj.motion
        if obj.motionParams:
            params = ", ".join(f"{k}={v:g}" for k, v in sorted(obj.motionParams.items()))
            named += f" ({params})"
        if obj.motionLoop:
            named += " looping"
        bits.append(named)

    window = _track_window(obj)
    if window:
        start, end = window
        bits.append(f"{start:.1f}–{end:.1f}s")
        bits.append("running now" if start <= now_t <= end else "not at playhead")
    return bits


def _format_motion(obj: ObjectSnapshot, now_t: float) -> str | None:
    """What this object is doing, named where the name is known.

    `summarize_track` can only guess "spin-like" from rotation-Y numbers, which
    is not something the crew can amend — "make that spin faster" needs to know
    it *is* a spin, with which params, over what window. The motion id is now
    carried through from ANIMATE_OBJECT rather than discarded.
    """
    bits = _live_motion_bits(obj, now_t)
    if not bits:
        return None
    return f"  motion: {' · '.join(bits)}"


def _live_motion_line(scene: SceneState) -> str:
    """One-line playhead summary: name, motion id, looping, running now vs not."""
    parts: list[str] = []
    now_t = scene.currentTime
    for obj in scene.objects:
        bits: list[str] = []
        if obj.motion:
            named = obj.motion
            if obj.motionLoop:
                named += " looping"
            bits.append(named)
        window = _track_window(obj)
        if window:
            start, end = window
            bits.append("running now" if start <= now_t <= end else "not at playhead")
        if bits:
            parts.append(f"{obj.name} {' · '.join(bits)}")
    if not parts:
        return "LIVE MOTION: none"
    return "LIVE MOTION: " + "; ".join(parts)


def _format_object(
    obj: ObjectSnapshot, full_mode: bool, rel: Relations | None = None, now_t: float = 0.0
) -> list[str]:
    kind = f" ({obj.primitive})" if obj.primitive else ""
    lines = [
        f'- id "{obj.id}" name "{obj.name}"{kind}',
        f"  base pos {_fmt_vec(obj.position)} rot {_fmt_vec(obj.rotation)} scale {_fmt_vec(obj.scale)}",
        f"  NOW  pos {_fmt_vec(obj.sampled.position)} rot {_fmt_vec(obj.sampled.rotation)} scale {_fmt_vec(obj.sampled.scale)}",
    ]
    size_line = _format_size(obj)
    if size_line:
        lines.append(size_line)
    rel_line = _format_relations(rel)
    if rel_line:
        lines.append(rel_line)
    track_parts: list[str] = []
    for track in obj.tracks:
        kfs = _track_keyframes(track)
        if kfs:
            track_parts.append(summarize_track(track.property, kfs))
        elif isinstance(track, KeyframeTrackSummary):
            track_parts.append(f"{track.property}×{track.keyframeCount}")
    if track_parts:
        lines.append(f"  tracks: {', '.join(track_parts)}")

    motion_line = _format_motion(obj, now_t)
    if motion_line:
        lines.append(motion_line)

    if full_mode:
        for track in obj.tracks:
            kfs = _track_keyframes(track)
            if kfs:
                listing = _format_keyframe_list(kfs)
                if listing:
                    lines.append(f"  {track.property} kf: {listing}")

    if obj.materialOverride:
        mat = obj.materialOverride
        mat_bits: list[str] = []
        if mat.color:
            mat_bits.append(f"color={mat.color}")
        if mat.emissive:
            mat_bits.append(f"emissive={mat.emissive}")
        if mat.emissiveIntensity is not None:
            mat_bits.append(f"emissiveIntensity={mat.emissiveIntensity:g}")
        if mat.opacity is not None:
            mat_bits.append(f"opacity={mat.opacity:g}")
        if mat_bits:
            lines.append(f"  material: {', '.join(mat_bits)}")
    return lines


def _format_virtual_camera(vc: VirtualCameraSnapshot, full_mode: bool) -> list[str]:
    lines = [
        "VIRTUAL CAMERA:",
        f"  base pos {_fmt_vec(vc.position)} fov {vc.fov:g}",
        f"  NOW  pos {_fmt_vec(vc.sampled.position)} fov {vc.sampledFov:g}",
    ]
    track_parts: list[str] = []
    for track in vc.tracks:
        kfs = _track_keyframes(track)
        if kfs:
            track_parts.append(summarize_track(track.property, kfs))
        elif isinstance(track, KeyframeTrackSummary):
            track_parts.append(f"{track.property}×{track.keyframeCount}")
    lines.append(f"  tracks: {', '.join(track_parts) or 'none'}")

    fx_bits: list[str] = []
    for section in vc.fx.enabledSections:
        if section == "bloom" and vc.fx.bloomStrength is not None:
            fx_bits.append(f"bloom({vc.fx.bloomStrength:g})")
        elif section == "dither" and vc.fx.ditherLevels is not None:
            fx_bits.append(f"dither({vc.fx.ditherLevels})")
        else:
            fx_bits.append(section)
    lines.append(f"  fx: {', '.join(fx_bits) if fx_bits else 'none'}")

    if full_mode:
        for track in vc.tracks:
            kfs = _track_keyframes(track)
            if kfs:
                listing = _format_keyframe_list(kfs)
                if listing:
                    lines.append(f"  {track.property} kf: {listing}")
    return lines


def _relations_for(scene: SceneState) -> dict[str, Relations]:
    """Derive spatial relations for every object that reported bounds.

    Objects without bounds (no mesh yet) are simply absent from the map, so the
    brief falls back to coordinates for them rather than inventing geometry.
    """
    placed = [
        Placed(
            name=o.name,
            box=Box(min=tuple(o.bounds.min), max=tuple(o.bounds.max)),
            kind=o.primitive,
        )
        for o in scene.objects
        if o.bounds is not None
    ]
    if not placed:
        return {}
    vc = scene.virtualCamera
    return describe_scene(
        placed,
        stage_center=tuple(scene.stage.position),
        stage_radius=scene.stage.radius,
        cam_pos=tuple(vc.sampled.position),
        cam_forward=forward_from_euler(tuple(vc.sampled.rotation)),
    )


def _format_lighting(scene: SceneState) -> str:
    amb = scene.lighting.ambient
    key = scene.lighting.key
    amb_color = amb.color or "#ffffff"
    amb_int = amb.intensity if amb.intensity is not None else 0.0
    key_color = key.color or "#ffffff"
    key_int = key.intensity if key.intensity is not None else 0.0
    key_pos = key.position or (5.0, 10.0, 7.0)
    return (
        f"LIGHTING: ambient {amb_color}×{amb_int:g} | "
        f"key {key_color}×{key_int:g} @{_fmt_vec(key_pos)} | "
        f"bg {scene.lighting.background}"
    )


def _transport_suffix(scene: SceneState) -> str:
    """Loop and clip state. Absent from the brief entirely until now, so "is it
    looping?" and "when does the clip end?" had no answer in the snapshot."""
    bits: list[str] = []
    if scene.isRolling:
        bits.append("ROLLING")
    bits.append("looping" if scene.playbackLoop else "play once")
    if scene.clipLoopEnd is not None:
        bits.append(f"clip ends {scene.clipLoopEnd:g}s")
    return " | " + " | ".join(bits) if bits else ""


def format_scene_brief(scene: SceneState | None) -> str:
    """Compact text briefing for LLM system prompt injection."""
    if scene is None:
        return "(scene snapshot unavailable)"

    full_mode = scene.mode == "full"
    play_state = "playing" if scene.isPlaying else "paused"
    selected = scene.selectedId or "none"
    lines = [
        f"TIMELINE: t={scene.currentTime:.2f}s / {scene.duration:g}s | {play_state}"
        f"{_transport_suffix(scene)} | selected={selected}",
        _live_motion_line(scene),
        f"STAGE: center {_fmt_vec(scene.stage.position)} radius {scene.stage.radius:g}",
        "",
        f"OBJECTS ({len(scene.objects)}):",
    ]

    if scene.objects:
        relations = _relations_for(scene)
        for obj in scene.objects:
            lines.extend(_format_object(obj, full_mode, relations.get(obj.name), scene.currentTime))
    else:
        lines.append("(empty)")

    lines.append("")
    lines.extend(_format_virtual_camera(scene.virtualCamera, full_mode))
    lines.append("")
    lines.append(_format_lighting(scene))
    return "\n".join(lines)


def describe_fallback_message(
    clause: str,
    scene: SceneState | None,
    topic: DescribeTopic,
    target: str | None = None,
) -> str:
    """Rule-parser describe responses when no LLM is available."""
    if scene is None:
        return "Scene snapshot unavailable — connect the editor and try again."

    if topic == "animation" and target:
        obj = next((o for o in scene.objects if o.name == target), None)
        if obj:
            y_now = obj.sampled.position[1]
            y_base = obj.position[1]
            track_hint = ""
            for track in obj.tracks:
                kfs = _track_keyframes(track)
                if track.property == "position" and kfs:
                    track_hint = summarize_track("position", kfs)
                    break
            return (
                f'"{target}" is at Y={y_now:g} now (base Y={y_base:g}) at t={scene.currentTime:.2f}s. '
                f"Tracks: {track_hint or 'none'}. "
                "Want me to tweak the bounce or hold the pose?"
            )
        return f'Could not find "{target}" in the scene.'

    if topic == "animation":
        animated = [o.name for o in scene.objects if o.keyframedProperties]
        if animated:
            return (
                f"At t={scene.currentTime:.2f}s, animated objects: {', '.join(animated)}. "
                "Sampled poses differ from base where tracks are active. "
                "Want a closer look at one object?"
            )
        return "No keyframed animation on objects right now."

    if topic == "lighting":
        return (
            f"Ambient {scene.lighting.ambient.color}×{scene.lighting.ambient.intensity}, "
            f"key {scene.lighting.key.color}×{scene.lighting.key.intensity}, "
            f"background {scene.lighting.background}. "
            "Should I warm, cool, or dim the set?"
        )

    if topic == "fx":
        fx = scene.virtualCamera.fx
        enabled = ", ".join(fx.enabledSections) if fx.enabledSections else "none"
        return f"Viewfinder FX enabled: {enabled}. Want to enable or tune a section?"

    if topic == "camera":
        vc = scene.virtualCamera
        return (
            f"Virtual camera at {_fmt_vec(vc.sampled.position)}, fov {vc.sampledFov:g}. "
            "Should I reframe or adjust zoom?"
        )

    # scene / object default
    brief = format_scene_brief(scene)
    return f"Here's the set at t={scene.currentTime:.2f}s:\n{brief}"
