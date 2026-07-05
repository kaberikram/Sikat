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
