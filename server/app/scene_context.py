"""Compact scene briefing for LLM system prompt injection."""
from __future__ import annotations

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


def _format_object(obj: ObjectSnapshot, full_mode: bool) -> list[str]:
    lines = [
        f'- id "{obj.id}" name "{obj.name}"',
        f"  base pos {_fmt_vec(obj.position)} rot {_fmt_vec(obj.rotation)} scale {_fmt_vec(obj.scale)}",
        f"  NOW  pos {_fmt_vec(obj.sampled.position)} rot {_fmt_vec(obj.sampled.rotation)} scale {_fmt_vec(obj.sampled.scale)}",
    ]
    track_parts: list[str] = []
    for track in obj.tracks:
        kfs = _track_keyframes(track)
        if kfs:
            track_parts.append(summarize_track(track.property, kfs))
        elif isinstance(track, KeyframeTrackSummary):
            track_parts.append(f"{track.property}×{track.keyframeCount}")
    if track_parts:
        lines.append(f"  tracks: {', '.join(track_parts)}")

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


def format_scene_brief(scene: SceneState | None) -> str:
    """Compact text briefing for LLM system prompt injection."""
    if scene is None:
        return "(scene snapshot unavailable)"

    full_mode = scene.mode == "full"
    play_state = "playing" if scene.isPlaying else "paused"
    selected = scene.selectedId or "none"
    lines = [
        f"TIMELINE: t={scene.currentTime:.2f}s / {scene.duration:g}s | {play_state} | selected={selected}",
        "",
        f"OBJECTS ({len(scene.objects)}):",
    ]

    if scene.objects:
        for obj in scene.objects:
            lines.extend(_format_object(obj, full_mode))
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
