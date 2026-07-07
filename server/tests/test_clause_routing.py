"""Clause routing — grammar vs LLM ownership."""
from app.creative_parse import defer_clause_to_llm, is_llm_owned_clause
from app.fallback_parser import parse_one_clause

from tests.helpers import scene_with


def test_spawn_grammar_owned_when_llm_available():
    scene = scene_with("BOX")
    intent = parse_one_clause("add a red box", scene)
    assert intent is not None
    assert defer_clause_to_llm("add a red box", intent, llm_available=True) is False
    assert is_llm_owned_clause("add a red box", intent, llm_available=True) is False


def test_bounce_defers_when_llm_available():
    scene = scene_with("CORE_SPHERE")
    intent = parse_one_clause("bounce the ball", scene)
    assert intent is not None
    assert defer_clause_to_llm("bounce the ball", intent, llm_available=True) is True


def test_bounce_instant_when_no_llm():
    scene = scene_with("CORE_SPHERE")
    intent = parse_one_clause("bounce the ball", scene)
    assert intent is not None
    assert defer_clause_to_llm("bounce the ball", intent, llm_available=False) is False


def test_creative_clause_defers_when_llm_available():
    scene = scene_with("CORE_SPHERE")
    clause = "make the sphere feel alive"
    intent = parse_one_clause(clause, scene)
    assert defer_clause_to_llm(clause, intent, llm_available=True) is True


def test_unparsed_clause_defers_to_llm():
    assert defer_clause_to_llm("xyzzy fuzz", None, llm_available=True) is True


def test_clarify_defers_when_llm_available():
    from app.schema import Intent

    intent = Intent(
        action="clarify",
        clarify_question="which one?",
        clarify_options=["a", "b"],
    )
    assert defer_clause_to_llm("move it", intent, llm_available=True) is True
    assert defer_clause_to_llm("move it", intent, llm_available=False) is False


def test_playback_grammar_owned_when_llm_available():
    intent = parse_one_clause("play", None)
    assert intent is not None
    assert defer_clause_to_llm("play", intent, llm_available=True) is False


def test_bloom_grammar_owned_when_llm_available():
    intent = parse_one_clause("enable bloom", None)
    assert intent is not None
    assert defer_clause_to_llm("enable bloom", intent, llm_available=True) is False
