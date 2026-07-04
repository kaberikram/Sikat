"""Creative vs instant routing for director clauses."""
from app.creative_parse import defer_clause_to_llm
from app.fallback_parser import parse_one_clause
from app.motion_variation import enrich_motion_params

from tests.helpers import scene_with


def test_bounce_defers_when_llm_available():
    scene = scene_with("CORE_SPHERE")
    intent = parse_one_clause("bounce the ball", scene)
    assert intent is not None
    assert defer_clause_to_llm("bounce the ball", intent, llm_available=True)
    assert defer_clause_to_llm("bounce the ball", intent, llm_available=False) is False


def test_creative_language_defers_without_llm():
    scene = scene_with("CORE_SPHERE")
    intent = parse_one_clause("orbit the sphere", scene)
    assert intent is not None
    assert defer_clause_to_llm(
        "make the sphere orbit nervously like it is lost",
        intent,
        llm_available=False,
    )


def test_playback_never_defers():
    intent = parse_one_clause("play", None)
    assert intent is not None
    assert defer_clause_to_llm("play", intent, llm_available=True) is False


def test_bounce_variation_seed():
    a = enrich_motion_params(None, "bounce", "cmd-a", 25.0)
    b = enrich_motion_params(None, "bounce", "cmd-b", 25.0)
    assert a["seed"] != b["seed"]
    assert a["hops"] != b["hops"] or a["height"] != b["height"]
