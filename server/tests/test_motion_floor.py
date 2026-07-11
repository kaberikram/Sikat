"""Tests for motion_floor — guaranteed animation fallback."""
from __future__ import annotations

import pytest

from app.motion_floor import is_animation_seeking, motion_floor_packets
from app.schema import SceneState
from tests.helpers import scene_with


@pytest.mark.parametrize(
    "text,expected",
    [
        ("surprise me with the animation", True),
        ("dance", True),
            ("choreograph a take", True),
            ("move the ball", True),
            ("make the sphere dance", True),
            ("describe the scene", False),
        ("hello", False),
        ("dim the lights", False),
        ("what's playing", False),
    ],
)
def test_is_animation_seeking(text: str, expected: bool):
    assert is_animation_seeking(text) == expected


def test_motion_floor_packets_produces_animate_playback():
    scene = scene_with("CORE_SPHERE", "BOX_01")
    packets = motion_floor_packets("surprise me", "cmd-floor")
    assert len(packets) >= 1
    assert packets[0].command == "ANIMATE_OBJECT"
    assert any(p.command == "PLAYBACK" for p in packets)


def test_motion_floor_packets_vary_by_command_id():
    scene = scene_with("CORE_SPHERE")
    p1 = motion_floor_packets("animate", "cmd-a")
    p2 = motion_floor_packets("animate", "cmd-b")
    # Different command IDs should produce different seeds
    assert p1 != p2 or p1[0].payload.motion != p2[0].payload.motion
