"""Timeline transport + loop commands."""
from app.fallback_parser import parse


def test_loop_on():
    (i,) = parse("loop")
    assert i.playback_action == "loop_on"


def test_loop_off():
    (i,) = parse("play once")
    assert i.playback_action == "loop_off"


def test_animate_repeat():
    from tests.helpers import scene_with

    scene = scene_with("CORE_SPHERE")
    (i,) = parse("loop the bounce on the sphere", scene)
    assert i.action == "animate"
    assert i.animate_repeat is True
    assert i.motion == "bounce"


def test_at_time_seek():
    (i,) = parse("at 2.5 seconds")
    assert i.playback_action == "seek"
    assert i.seek_time == 2.5
