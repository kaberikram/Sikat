"""Tests for scene_context.format_scene_brief and track heuristics."""
from app.scene_context import format_scene_brief, summarize_track
from app.schema import KeyframeTrackFull, KeyframePoint

from tests.helpers import animated_sphere_scene, scene_with


def test_format_scene_brief_empty_scene():
    brief = format_scene_brief(scene_with())
    assert "OBJECTS (0)" in brief
    assert "(empty)" in brief
    assert "VIRTUAL CAMERA" in brief
    assert "LIGHTING:" in brief


def test_format_scene_brief_heartbeat_vs_full():
    scene = animated_sphere_scene()
    scene.mode = "heartbeat"
    heartbeat = format_scene_brief(scene)
    assert "position×6" in heartbeat
    assert "position kf:" not in heartbeat

    scene.mode = "full"
    full = format_scene_brief(scene)
    assert "position kf:" in full
    assert "0@(" in full


def test_format_scene_brief_sampled_pose():
    brief = format_scene_brief(animated_sphere_scene())
    assert "NOW  pos (0,1.2,0)" in brief
    assert "selected=id0" in brief
    assert "playing" in brief


def test_summarize_track_bounce_heuristic():
    keyframes = [
        KeyframePoint(time=0.0, value=(0.0, 0.0, 0.0)),
        KeyframePoint(time=1.0, value=(0.0, 2.5, 0.0)),
        KeyframePoint(time=2.0, value=(0.0, 0.0, 0.0)),
        KeyframePoint(time=3.0, value=(0.0, 2.5, 0.0)),
    ]
    summary = summarize_track("position", keyframes)
    assert "position×4" in summary
    assert "bounce-like" in summary
    assert "Y range" in summary


def test_summarize_track_rotation_spin():
    keyframes = [
        KeyframePoint(time=0.0, value=(0.0, 0.0, 0.0)),
        KeyframePoint(time=2.0, value=(0.0, 3.14, 0.0)),
        KeyframePoint(time=4.0, value=(0.0, 6.28, 0.0)),
    ]
    summary = summarize_track("rotation", keyframes)
    assert "spin/turnaround-like" in summary


def test_format_keyframe_list_caps_long_tracks():
    scene = animated_sphere_scene()
    long_kfs = [
        KeyframePoint(time=float(i), value=(0.0, float(i), 0.0)) for i in range(25)
    ]
    scene.objects[0].tracks = [
        KeyframeTrackFull(property="position", keyframes=long_kfs),
    ]
    brief = format_scene_brief(scene)
    assert "…" in brief
    assert "(25 total)" in brief
