"""Tests for director_vocab normalization + expanded instant grammar."""
from app.director_vocab import normalize_clause
from app.fallback_parser import parse

from tests.helpers import scene_with


def test_normalize_close_up():
    assert "zoom in" in normalize_clause("close-up on the ball")


def test_normalize_reveal_spawn():
    assert normalize_clause("reveal a red sphere").startswith("add")


def test_normalize_write_text():
    assert "add text saying" in normalize_clause('write "LAUNCH"')


def test_normalize_thats_a_wrap():
    assert normalize_clause("that's a wrap") == "cut"


def test_instant_reveal_red_sphere():
    (i,) = parse("reveal a red sphere")
    assert i.action == "spawn"
    assert i.primitive == "sphere"
    assert i.color == "#ff3b30"


def test_instant_close_up():
    scene = scene_with()
    scene.virtualCamera.fov = 60
    (i,) = parse("close-up", scene)
    assert i.action == "move_camera"
    assert i.fov == 45


def test_instant_make_it_bounce():
    scene = scene_with("CORE_SPHERE")
    parse("move the sphere up 1", scene)
    (i,) = parse("make it bounce", scene)
    assert i.action == "animate"
    assert i.preset == "bounce"


def test_instant_spin_without_degrees():
    scene = scene_with("CORE_SPHERE")
    (i,) = parse("spin the sphere", scene)
    assert i.action == "animate"
    assert i.motion == "spin"


def test_instant_dramatic_mood():
    (i,) = parse("dramatic mood")
    assert i.action == "set_scene"
    assert i.mood == "noir"


def test_instant_title_text():
    (i,) = parse("title LAUNCH")
    assert i.action == "spawn"
    assert i.primitive == "text"


def test_instant_hide_object():
    scene = scene_with("BOX_MDL_01")
    (i,) = parse("hide the box", scene)
    assert i.action == "remove"
    assert i.target == "BOX_MDL_01"


def test_instant_huge_scale():
    scene = scene_with("CORE_SPHERE")
    (i,) = parse("make the sphere huge", scene)
    assert i.action == "transform"
    assert i.scale == (1.5, 1.5, 1.5)


def test_instant_spotlight_lights():
    (i,) = parse("spotlight on the stage")
    assert i.action == "update_lights"
    assert i.key_intensity == 2.2
