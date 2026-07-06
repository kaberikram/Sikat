"""Tests for default motion transition injection."""
from __future__ import annotations

import pytest

from app.schema import ObjectSnapshot, SampledTransform, SceneState, StageSnapshot
from app.transitions import default_ambient_transition, default_object_transition
from tests.helpers import scene_with


def test_default_object_transition_scales_with_distance():
    scene = scene_with("BOX_MDL_01")
    obj = scene.objects[0]
    obj.sampled = SampledTransform(
        position=(0.0, 0.0, 0.0), rotation=(0.0, 0.0, 0.0), scale=(1.0, 1.0, 1.0)
    )
    small = default_object_transition(scene, obj.name, (0.0, 0.5, 0.0), "relative")
    large = default_object_transition(scene, obj.name, (0.0, 10.0, 0.0), "relative")
    assert small.easing == "easeOut"
    assert large.easing == "easeOut"
    assert 0.6 <= small.durationSec <= 0.9
    assert 0.6 <= large.durationSec <= 0.9
    assert large.durationSec >= small.durationSec


def test_default_object_transition_clamps_bounds():
    t = default_object_transition(None, None, (0.0, 0.01, 0.0), "relative")
    assert t.durationSec == 0.6
    t = default_object_transition(None, None, (0.0, 100.0, 0.0), "relative")
    assert t.durationSec == 0.9


def test_default_ambient_transition():
    t = default_ambient_transition()
    assert t.durationSec == 0.75
    assert t.easing == "easeOut"


async def test_move_without_duration_gets_default_transition(producer, scene):
    packets, _ = await producer.handle_user_command("move the box up 2", scene)
    (packet,) = packets
    assert packet.command == "TRANSFORM_OBJECT"
    assert packet.transition is not None
    assert packet.transition.easing == "easeOut"
    assert 0.6 <= packet.transition.durationSec <= 0.9


async def test_snap_keyword_strips_transition(producer, scene):
    packets, _ = await producer.handle_user_command("snap move the box up 2", scene)
    (packet,) = packets
    assert packet.command == "TRANSFORM_OBJECT"
    assert packet.transition is None


async def test_explicit_duration_wins_over_default(producer, scene):
    packets, _ = await producer.handle_user_command(
        "move the box up 2 over 3 seconds", scene
    )
    (packet,) = packets
    assert packet.transition.durationSec == 3.0
