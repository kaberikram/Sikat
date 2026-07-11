"""Tests for salvage_step — recovering from malformed streamed plan steps."""
from __future__ import annotations

from app.salvage import salvage_step
from app.schema import Intent


def test_salvage_valid_step_passes_through():
    raw = '{"action": "animate", "target": "CORE_SPHERE", "say": "moving"}'
    result = salvage_step(raw)
    assert result is not None
    assert result.action == "animate"
    assert result.target == "CORE_SPHERE"


def test_salvage_repairs_2_vector_keyframes():
    raw = (
        '{"action": "animate", "target": "CORE_SPHERE", '
        '"track_property": "position", '
        '"track_keyframes": ['
        '  {"time": 0, "value": [0, 1]},'
        '  {"time": 1, "value": [1, 2]}'
        ']'
        '}'
    )
    result = salvage_step(raw)
    assert result is not None
    assert result.track_keyframes is not None
    assert len(result.track_keyframes) == 2
    assert result.track_keyframes[0].value == (0.0, 1.0, 0.0)
    assert result.track_keyframes[1].value == (1.0, 2.0, 0.0)


def test_salvage_repairs_4_vector_keyframes():
    raw = (
        '{"action": "animate", "target": "BALL", '
        '"track_keyframes": ['
        '  {"time": 0, "value": [0, 1, 2, 3]},'
        '  {"time": 1, "value": [3, 4, 5, 6]}'
        ']'
        '}'
    )
    result = salvage_step(raw)
    assert result is not None
    assert result.track_keyframes is not None
    assert len(result.track_keyframes) == 2
    assert result.track_keyframes[0].value == (0.0, 1.0, 2.0)
    assert result.track_keyframes[1].value == (3.0, 4.0, 5.0)


def test_salvage_drops_single_keyframe_set():
    raw = (
        '{"action": "animate", "target": "BALL", '
        '"track_keyframes": ['
        '  {"time": 0, "value": [0, 1, 2]}'
        ']'
        '}'
    )
    result = salvage_step(raw)
    assert result is not None
    assert result.track_keyframes is None


def test_salvage_drops_unfixable_keyframes():
    raw = (
        '{"action": "animate", "target": "BALL", '
        '"track_keyframes": ['
        '  {"time": 0, "value": "not_a_list"},'
        '  {"time": 1, "value": [1, 2, 3]}'
        ']'
        '}'
    )
    result = salvage_step(raw)
    assert result is not None
    assert result.track_keyframes is None


def test_salvage_returns_none_for_garbage():
    result = salvage_step("this is not json at all {{{")
    assert result is None


def test_salvage_strips_unknown_fields():
    raw = (
        '{"action": "spawn", "primitive": "box", '
        '"color": "#ff3b30", "unknown_field": "should be stripped"}'
    )
    result = salvage_step(raw)
    assert result is not None
    assert result.action == "spawn"
    assert result.primitive == "box"
    assert result.color == "#ff3b30"


def test_salvage_mixed_valid_and_invalid_keyframes():
    """One invalid kf (non-list value), one valid — should drop whole set
    since we need ≥2 repaired keyframes."""
    raw = (
        '{"action": "animate", "target": "BALL", '
        '"track_keyframes": ['
        '  {"time": 0, "value": [0, 1, 2]},'
        '  {"time": 1, "value": "bad"}'
        ']'
        '}'
    )
    result = salvage_step(raw)
    assert result is not None
    # Only one repair survived → dropped
    assert result.track_keyframes is None
