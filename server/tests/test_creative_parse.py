"""Tests for creative_parse routing helpers."""
from app.creative_parse import is_open_direction


def test_is_open_direction_positive():
    assert is_open_direction("make it feel like a music video intro")
    assert is_open_direction("kind of moody and dramatic")


def test_is_open_direction_negative_with_object_verb():
    assert not is_open_direction("move the box like it's nervous")
    assert not is_open_direction("add a red box")
    assert not is_open_direction("enable bloom")
