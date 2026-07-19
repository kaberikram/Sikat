"""Intent previews carry the spatial payload ghost previews render from."""
from app.intent_preview import build_intent_preview

from tests.helpers import scene_with


def test_spawn_preview_carries_primitive_and_color():
    preview = build_intent_preview("add a red box", scene_with(), "cmd1")
    assert preview is not None
    assert preview["action"] == "spawn"
    assert preview["primitive"] == "box"
    assert preview.get("color") is not None


def test_move_preview_carries_relative_position():
    scene = scene_with("BOX")
    preview = build_intent_preview("move the box up 2", scene, "cmd2")
    assert preview is not None
    assert preview["action"] == "transform"
    assert preview["target"] == "BOX"
    assert preview["position"] == (0.0, 2.0, 0.0)
    assert preview["mode"] == "relative"


def test_scale_preview_carries_scale():
    scene = scene_with("BOX")
    preview = build_intent_preview("make the box bigger", scene, "cmd3")
    assert preview is not None
    assert preview["scale"] == (1.5, 1.5, 1.5)


def test_rotate_preview_carries_rotation():
    import math

    scene = scene_with("BOX")
    preview = build_intent_preview("rotate the box 90 degrees", scene, "cmd5")
    assert preview is not None
    assert preview["action"] == "transform"
    assert preview["mode"] == "relative"
    assert preview["rotation"][1] == math.pi / 2


def test_non_spatial_preview_has_no_ghost_fields():
    preview = build_intent_preview("enable bloom", None, "cmd4")
    assert preview is not None
    assert "position" not in preview
    assert "primitive" not in preview
