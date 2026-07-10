"""Contract tests for authored-motion-first plan prompts."""

from app.agents.asset_animator import AssetAnimator
from app.motion_policy import soften_default_motion
from app.prompts import build_plan_prompt
from app.schema import Intent, Keyframe, SceneState, StageSnapshot


def test_strong_prompt_requires_authored_keyframes_for_bare_animate():
    prompt = build_plan_prompt(None, "", tier="strong")
    assert "track_keyframes" in prompt
    assert "REQUIRED" in prompt or "MUST author track_keyframes" in prompt
    assert "Do NOT pick a motion id for bare animate" in prompt
    assert "animate the blue ball" in prompt
    assert '"track_property":"position"' in prompt or '"track_property": "position"' in prompt
    # Catalog shortcuts must not be the bare-animate default.
    assert "Bare animate → float" not in prompt
    assert "Bare \"animate the ball\" → float" not in prompt


def test_fast_prompt_escalates_bare_creative_animate():
    prompt = build_plan_prompt(
        SceneState(stage=StageSnapshot(position=(0, 0, 0), radius=25)),
        "",
        tier="fast",
    )
    assert "needs_deeper_creativity" in prompt
    assert "literal verbs" in prompt.lower()
    assert "Bare animate → float" not in prompt


def test_authored_blue_ball_emits_set_keyframes_not_motion_id():
    """Success criterion: bare-animate authorship → SET_KEYFRAMES, not float/wander."""
    intent = Intent(
        action="animate",
        target="Blue Ball",
        track_property="position",
        animate_repeat=True,
        track_keyframes=[
            Keyframe(time=0, value=(0, 1, 0)),
            Keyframe(time=0.6, value=(0.35, 1.35, 0.1)),
            Keyframe(time=1.4, value=(0.55, 1.15, -0.2)),
            Keyframe(time=2.2, value=(0.15, 1.45, -0.35)),
            Keyframe(time=3.0, value=(-0.3, 1.2, -0.15)),
            Keyframe(time=3.8, value=(-0.4, 1.4, 0.2)),
            Keyframe(time=4.6, value=(-0.1, 1.1, 0.35)),
            Keyframe(time=5.5, value=(0, 1, 0)),
        ],
        say="soft figure path on the blue",
    )
    packets = AssetAnimator().build(intent)
    assert packets[0].command == "SET_KEYFRAMES"
    assert packets[0].payload.property == "position"
    assert len(packets[0].payload.keyframes) == 8
    assert all(p.command != "ANIMATE_OBJECT" for p in packets)


def test_strong_prompt_frames_bounce_as_pro_craft():
    prompt = build_plan_prompt(None, "", tier="strong")
    assert "ballistic bounce" in prompt or "pro physics" in prompt.lower() or "craft synth" in prompt
    assert '"motion":"bounce"' in prompt or '"motion": "bounce"' in prompt


def test_literal_bounce_still_uses_motion_id():
    packets = AssetAnimator().build(
        Intent(action="animate", target="Blue Ball", motion="bounce")
    )
    assert len(packets) == 1
    assert packets[0].command == "ANIMATE_OBJECT"
    assert packets[0].payload.motion == "bounce"


def test_wander_safety_net_still_softens_unsolicited_wander():
    out = soften_default_motion(
        "animate the blue ball",
        Intent(action="animate", target="Blue Ball", motion="wander"),
    )
    assert out.motion == "float"
