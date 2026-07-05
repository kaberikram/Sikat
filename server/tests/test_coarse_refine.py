"""Coarse-then-refine parse policy tests."""
from app.creative_parse import (
    defer_clause_to_llm,
    needs_llm_refinement,
    should_coarse_emit,
)
from app.fallback_parser import parse_one_clause

from tests.helpers import scene_with


def test_bounce_coarse_emit_when_llm_available():
    scene = scene_with("CORE_SPHERE")
    intent = parse_one_clause("bounce the ball", scene)
    assert intent is not None
    assert should_coarse_emit(intent)
    assert needs_llm_refinement("bounce the ball", intent, llm_available=True)
    assert defer_clause_to_llm("bounce the ball", intent, llm_available=True) is False


def test_bounce_instant_when_no_llm():
    scene = scene_with("CORE_SPHERE")
    intent = parse_one_clause("bounce the ball", scene)
    assert intent is not None
    assert defer_clause_to_llm("bounce the ball", intent, llm_available=False) is False
    assert needs_llm_refinement("bounce the ball", intent, llm_available=False) is False


def test_creative_animate_still_coarse_emits():
    scene = scene_with("CORE_SPHERE")
    clause = "give the sphere a dramatic arc"
    intent = parse_one_clause("arc the sphere", scene)
    assert intent is not None
    assert should_coarse_emit(intent)
    assert needs_llm_refinement(clause, intent, llm_available=True)


def test_playback_never_defers():
    intent = parse_one_clause("play", None)
    assert intent is not None
    assert defer_clause_to_llm("play", intent, llm_available=True) is False
