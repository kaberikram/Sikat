"""Tests for motion_floor — guaranteed animation fallback.

The invariant that matters: whatever this returns, the object it animates
exists by the time the animate packet runs — either because it was already on
set, or because these packets spawn it first.

That is exactly what the old tests could not see. They built a scene and then
never passed it, so every case exercised the empty-scene path, and they asserted
only on `packet.command` and never on `payload.target.name`. The improviser
shipped animating a `HERO_SPHERE` it never spawned, and the suite stayed green.
"""
from __future__ import annotations

import pytest

from app.motion_floor import is_animation_seeking, motion_floor_packets
from app.shine_presets import HERO_SPAWN_NAME
from tests.helpers import scene_with


@pytest.mark.parametrize(
    "text,expected",
    [
        ("surprise me with the animation", True),
        ("dance", True),
        ("choreograph a take", True),
        ("move the ball", True),
        ("make the sphere dance", True),
        ("animation goes crazy", True),
        ("describe the scene", False),
        ("hello", False),
        ("dim the lights", False),
        ("what's playing", False),
    ],
)
def test_is_animation_seeking(text: str, expected: bool):
    assert is_animation_seeking(text) == expected


def _names_spawned(packets) -> set[str]:
    return {p.payload.name for p in packets if p.command == "SPAWN_OBJECT"}


def _motion_targets(packets) -> list[str]:
    names: list[str] = []
    for p in packets:
        if p.command in ("ANIMATE_OBJECT", "SET_KEYFRAMES") and p.payload.target:
            names.append(p.payload.target.name)
    return names


def test_every_animate_target_exists_or_is_spawned_first():
    """The invariant, on both branches. This is the regression."""
    for scene in (scene_with(), scene_with("CORE_SPHERE", "BOX_01")):
        packets = motion_floor_packets("surprise me", "cmd-floor", scene)
        on_set = {o.name for o in scene.objects}
        available = on_set | _names_spawned(packets)
        for target in _motion_targets(packets):
            assert target in available, f"animating {target!r}, which nothing provides"


def test_empty_set_spawns_the_hero_before_animating_it():
    packets = motion_floor_packets("surprise me", "cmd-floor", scene_with())
    assert packets[0].command == "SPAWN_OBJECT"
    assert packets[0].payload.name == HERO_SPAWN_NAME
    assert packets[0].payload.primitive == "sphere"
    # Order matters — the spawn has to reach the client first.
    assert _motion_targets(packets) == [HERO_SPAWN_NAME]


def test_a_populated_set_is_used_rather_than_conjuring_a_sphere():
    scene = scene_with("PEDESTAL", "SNEAKER_ONE", "SET_SIGN")
    packets = motion_floor_packets("surprise me", "cmd-floor", scene)
    assert not _names_spawned(packets), "should not add clutter to a dressed set"
    assert _motion_targets(packets) == ["PEDESTAL"]  # equal scale → first wins
    assert HERO_SPAWN_NAME not in _motion_targets(packets)


def test_open_brief_floor_is_authored_keys():
    packets = motion_floor_packets("surprise me", "cmd-floor", scene_with("CORE_SPHERE"))
    keys = next(p for p in packets if p.command == "SET_KEYFRAMES")
    assert len(keys.payload.keyframes) == 8
    assert any(p.command == "PLAYBACK" for p in packets)
    assert all(p.command != "ANIMATE_OBJECT" for p in packets)


def test_literal_bounce_floor_stays_catalog():
    packets = motion_floor_packets("bounce the ball", "cmd-floor", scene_with("CORE_SPHERE"))
    assert any(p.command == "ANIMATE_OBJECT" for p in packets)
    assert all(p.command != "SET_KEYFRAMES" for p in packets)


def test_motion_floor_packets_vary_by_command_id():
    scene = scene_with("CORE_SPHERE")
    p1 = motion_floor_packets("surprise me", "cmd-a", scene)
    p2 = motion_floor_packets("surprise me", "cmd-b", scene)
    a1 = next(p for p in p1 if p.command == "SET_KEYFRAMES")
    a2 = next(p for p in p2 if p.command == "SET_KEYFRAMES")
    assert a1.payload.keyframes != a2.payload.keyframes
