"""Generative motion — instant grammar + intent fields."""
from app.fallback_parser import parse

from tests.helpers import scene_with


def test_float_gentle():
    scene = scene_with("CORE_SPHERE")
    (i,) = parse("float the sphere gently", scene)
    assert i.action == "animate"
    assert i.motion == "float"
    assert i.motion_params is not None
    assert i.motion_params.get("amplitude", 1) <= 0.35


def test_bounce_high():
    scene = scene_with("CORE_SPHERE")
    (i,) = parse("high bounce on the sphere", scene)
    assert i.motion == "bounce"
    assert i.motion_params["height"] >= 2.5


def test_drop_motion():
    scene = scene_with("HERO")
    (i,) = parse("drop the hero from 3 meters", scene)
    assert i.motion == "drop"
    assert i.motion_params.get("height") == 3.0


def test_figure8():
    scene = scene_with("CORE_SPHERE")
    (i,) = parse("figure 8 the sphere", scene)
    assert i.motion == "figure8"


def test_three_hops_parsed():
    scene = scene_with("CORE_SPHERE")
    (i,) = parse("high bounce on the sphere — three hops", scene)
    assert i.motion == "bounce"
    assert i.motion_params["hops"] == 3
    assert i.motion_params["height"] >= 2.5


def test_drop_metres_spelling():
    scene = scene_with("CORE_SPHERE")
    (i,) = parse("drop the sphere 3 metres", scene)
    assert i.motion == "drop"
    assert i.motion_params["height"] == 3.0


def test_wander_freely():
    scene = scene_with("CORE_SPHERE")
    (i,) = parse("move the ball freely", scene)
    assert i.action == "animate"
    assert i.motion == "wander"
    assert i.target == "CORE_SPHERE"


def test_squash_animate_not_instant_transform():
    scene = scene_with("BLUE_SPHERE")
    (i,) = parse("animate blue sphere squashed", scene)
    assert i.action == "animate"
    assert i.motion == "squash"
    assert i.target == "BLUE_SPHERE"
    assert i.motion_params is not None
    assert i.motion_params.get("flat") == 0.35


def test_squash_the_sphere_is_animated():
    scene = scene_with("CORE_SPHERE")
    (i,) = parse("squash the sphere", scene)
    assert i.action == "animate"
    assert i.motion == "squash"


def test_orbit_stage_pivot():
    scene = scene_with("CORE_SPHERE")
    (i,) = parse("orbit the stage on the sphere", scene)
    assert i.motion == "orbit"
    assert i.motion_params.get("pivot") == 1.0


def test_asset_animator_passes_motion():
    from app.agents.asset_animator import AssetAnimator
    from app.schema import Intent

    packets = AssetAnimator().build(
        Intent(
            action="animate",
            target="CORE_SPHERE",
            motion="float",
            motion_params={"amplitude": 0.4, "frequency": 1.2},
        )
    )
    assert len(packets) == 1
    p = packets[0].payload
    assert p.motion == "float"
    assert p.params == {"amplitude": 0.4, "frequency": 1.2}
