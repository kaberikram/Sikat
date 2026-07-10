from app.motion_policy import soften_default_motion
from app.schema import Intent


def test_bare_animate_wander_becomes_float():
    intent = Intent(action="animate", target="Blue Ball", motion="wander", motion_params={"waypoints": 5})
    out = soften_default_motion("animate the blue ball", intent)
    assert out.motion == "float"
    assert out.motion_params is not None
    assert out.motion_params.get("amplitude") == 0.45


def test_explicit_wander_is_kept():
    intent = Intent(action="animate", target="Blue Ball", motion="wander")
    out = soften_default_motion("make the blue ball wander around", intent)
    assert out.motion == "wander"
