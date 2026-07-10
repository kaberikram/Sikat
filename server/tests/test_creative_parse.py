"""Tests for creative_parse routing helpers."""
from app.creative_parse import defer_clause_to_llm, is_open_direction
from app.schema import Intent


def test_is_open_direction_positive():
    assert is_open_direction("make it feel like a music video intro")
    assert is_open_direction("kind of moody and dramatic")


def test_is_open_direction_negative_with_object_verb():
    assert not is_open_direction("move the box like it's nervous")
    assert not is_open_direction("add a red box")
    assert not is_open_direction("enable bloom")


def test_complete_assign_is_grammar_owned():
    intent = Intent(action="assign", addressee=1, target="CORE_SPHERE")
    assert defer_clause_to_llm(
        "Agent 1 you're on the sphere", intent, llm_available=True
    ) is False


def test_incomplete_assign_defers_to_llm():
    intent = Intent(action="assign", addressee=1)
    assert defer_clause_to_llm("Agent 1 you're on", intent, llm_available=True) is True


def test_describe_still_defers_when_not_open_speech():
    intent = Intent(action="describe", say="looking at the stage")
    assert defer_clause_to_llm("what's on stage", intent, llm_available=True) is True
