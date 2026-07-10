"""Intent preview builder tests."""
from app.intent_preview import build_intent_preview

from tests.helpers import scene_with


def test_preview_from_grammar_animate():
    scene = scene_with("CORE_SPHERE")
    preview = build_intent_preview(
        "Agent 1, arc the sphere", scene, "cmd-1"
    )
    assert preview is not None
    assert preview["agent"] == "Agent1"
    assert preview["target"] == "CORE_SPHERE"
    assert preview["confidence"] == "grammar"
    assert "sphere" in preview["note"].lower() or "arc" in preview["note"].lower()


def test_preview_guess_from_object_name():
    scene = scene_with("MyBox")
    preview = build_intent_preview("move MyBox up", scene, "cmd-2")
    assert preview is not None
    assert preview["target"] == "MyBox"


def test_preview_none_for_empty():
    assert build_intent_preview("hello there", scene_with("CORE_SPHERE"), "cmd-3") is None


def test_preview_animate_the_ball_without_motion():
    """'animate the ball' has no motion word — grammar misses, but preview must
    still steer AssetAnimator via ball→sphere slang + animate verb."""
    scene = scene_with("CORE_SPHERE")
    preview = build_intent_preview("animate the ball", scene, "cmd-4")
    assert preview is not None
    assert preview["agent"] == "AssetAnimator"
    assert preview["target"] == "CORE_SPHERE"
    assert preview["action"] == "animate"
    assert preview["confidence"] == "guess"
