"""Rule-grammar tests covering the demo script phrases end to end."""
import math

from app.fallback_parser import parse
from app.schema import CameraSnapshot, ObjectSnapshot, SceneState


def scene_with(*names: str) -> SceneState:
    return SceneState(
        objects=[
            ObjectSnapshot(id=f"id{i}", name=name) for i, name in enumerate(names)
        ],
        camera=CameraSnapshot(fov=50),
    )


def test_spawn_red_box():
    intents = parse("add a red box")
    assert len(intents) == 1
    i = intents[0]
    assert i.action == "spawn"
    assert i.primitive == "box"
    assert i.color == "#ff3b30"


def test_spawn_named_at_position():
    (i,) = parse("spawn a sphere called hero at 1 2 3")
    assert i.action == "spawn"
    assert i.primitive == "sphere"
    assert i.name == "HERO"
    assert i.position == (1, 2, 3)


def test_move_up_with_duration():
    scene = scene_with("BOX_MDL_01")
    (i,) = parse("move the box up 2 over 3 seconds", scene)
    assert i.action == "transform"
    assert i.target == "BOX_MDL_01"
    assert i.mode == "relative"
    assert i.position == (0, 2, 0)
    assert i.transition is not None
    assert i.transition.durationSec == 3.0


def test_dim_the_lights():
    (i,) = parse("dim the lights")
    assert i.action == "update_lights"
    assert i.ambient_intensity == 0.3
    assert i.key_intensity == 0.7


def test_background_color():
    (i,) = parse("make the background black")
    assert i.action == "update_lights"
    assert i.background == "#111111"


def test_sunset_mood():
    (i,) = parse("sunset mood")
    assert i.action == "set_scene"
    assert i.mood == "sunset"


def test_make_it_noir():
    (i,) = parse("make it feel noir")
    assert i.action == "set_scene"
    assert i.mood == "noir"


def test_enable_bloom():
    (i,) = parse("enable bloom")
    assert i.action == "update_fx"
    assert i.section == "bloom"
    assert i.fx_enabled is True


def test_more_glitch():
    (i,) = parse("more glitch")
    assert i.action == "update_fx"
    assert i.section == "glitch"
    assert i.fx_set and i.fx_set[0].key == "intensity"


def test_bloom_strength_to_value():
    (i,) = parse("set bloom strength to 1.4")
    assert i.section == "bloom"
    assert any(s.key == "strength" and s.value == 1.4 for s in i.fx_set)


def test_turnaround_resolves_scene_object():
    scene = scene_with("CORE_SPHERE")
    (i,) = parse("turnaround the sphere", scene)
    assert i.action == "animate"
    assert i.preset == "turnaround"
    assert i.target == "CORE_SPHERE"


def test_rotate_degrees_to_radians():
    (i,) = parse("rotate the box 90 degrees")
    assert i.action == "transform"
    assert i.rotation is not None
    assert math.isclose(i.rotation[1], math.pi / 2)


def test_scale_double():
    (i,) = parse("double the sphere")
    assert i.action == "transform"
    assert i.scale == (2.0, 2.0, 2.0)
    assert i.mode == "relative"


def test_playback_play_pause_seek():
    assert parse("play")[0].playback_action == "play"
    assert parse("cut")[0].playback_action == "pause"
    seek = parse("go to 2.5 seconds")[0]
    assert seek.playback_action == "seek"
    assert seek.seek_time == 2.5


def test_camera_zoom_uses_scene_fov():
    scene = scene_with()
    scene.camera.fov = 60
    (i,) = parse("zoom in", scene)
    assert i.action == "move_camera"
    assert i.fov == 45


def test_camera_look_at():
    scene = scene_with("BOX_MDL_01")
    (i,) = parse("camera look at the box", scene)
    assert i.action == "move_camera"
    assert i.look_at == "BOX_MDL_01"


def test_paint_existing_object():
    scene = scene_with("CORE_SPHERE")
    (i,) = parse("paint the sphere gold", scene)
    assert i.action == "set_material"
    assert i.target == "CORE_SPHERE"
    assert i.color == "#ffd700"


def test_make_without_existing_object_spawns():
    (i,) = parse("make a blue cone")
    assert i.action == "spawn"
    assert i.primitive == "cone"
    assert i.color == "#0a84ff"


def test_remove_object():
    scene = scene_with("BOX_MDL_01")
    (i,) = parse("delete the box", scene)
    assert i.action == "remove"
    assert i.target == "BOX_MDL_01"


def test_multi_clause_then():
    intents = parse("add a red box then dim the lights")
    assert [i.action for i in intents] == ["spawn", "update_lights"]


def test_unparseable_returns_empty():
    assert parse("what is the meaning of life") == []


def test_disable_bloom():
    (i,) = parse("disable bloom")
    assert i.action == "update_fx"
    assert i.section == "bloom"
    assert i.fx_enabled is False


def test_warm_lights():
    (i,) = parse("warm lights")
    assert i.action == "update_lights"
    assert i.ambient_color == "#ffd9a8"
    assert i.key_color == "#ffb066"


def test_cool_lights():
    (i,) = parse("cooler lighting")
    assert i.action == "update_lights"
    assert i.ambient_color == "#a8c8ff"
    assert i.key_color == "#7fb4ff"


def test_camera_to_xyz():
    (i,) = parse("camera to 1 2 3")
    assert i.action == "move_camera"
    assert i.position == (1.0, 2.0, 3.0)


def test_text_spawn():
    (i,) = parse('add text saying "hello world"')
    assert i.action == "spawn"
    assert i.primitive == "text"
    assert i.text == '"hello world"'


def test_scale_absolute():
    scene = scene_with("CORE_SPHERE")
    (i,) = parse("scale the sphere to 2", scene)
    assert i.action == "transform"
    assert i.mode == "absolute"
    assert i.scale == (2.0, 2.0, 2.0)


def test_orbit_preset():
    scene = scene_with("CORE_SPHERE")
    (i,) = parse("orbit the sphere", scene)
    assert i.action == "animate"
    assert i.preset == "orbit"
    assert i.target == "CORE_SPHERE"


def test_bounce_preset():
    scene = scene_with("BOX_MDL_01")
    (i,) = parse("bounce the box", scene)
    assert i.action == "animate"
    assert i.preset == "bounce"
    assert i.target == "BOX_MDL_01"


def test_clause_split_semicolon():
    intents = parse("play; pause")
    assert [i.playback_action for i in intents] == ["play", "pause"]


def test_fx_substring_non_match():
    assert parse("spotlight on the stage") == []
