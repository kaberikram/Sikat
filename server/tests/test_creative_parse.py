"""Tests for creative_parse routing helpers."""
from app.creative_parse import (
    catalog_motion_forbidden,
    defer_clause_to_llm,
    is_open_direction,
    is_stock_showcase,
    said_literal_motion,
)
from app.schema import Intent


def test_is_open_direction_positive():
    assert is_open_direction("make it feel like a music video intro")
    assert is_open_direction("kind of moody and dramatic")
    assert is_open_direction("surprise me")
    assert is_open_direction("blow my mind")
    assert is_open_direction("I trust you")
    assert is_open_direction("go off")
    assert is_open_direction("neon Tokyo")
    assert is_open_direction("make it insane")
    assert is_open_direction("goes crazy")
    assert is_open_direction("animation goes crazy")
    assert is_open_direction("go crazy")


def test_is_open_direction_negative_with_object_verb():
    assert not is_open_direction("move the box like it's nervous")
    assert not is_open_direction("add a red box")
    assert not is_open_direction("enable bloom")
    assert not is_open_direction("make the sphere bounce")


def test_stock_showcase_is_not_open_direction():
    assert is_stock_showcase("default showcase")
    assert is_stock_showcase("stock product showcase")
    assert not is_open_direction("default showcase")
    assert not is_stock_showcase("product showcase")
    assert not is_stock_showcase("neon Tokyo")


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


def test_mood_defers_to_llm_when_available():
    intent = Intent(action="set_scene", mood="neon")
    assert defer_clause_to_llm("neon Tokyo", intent, llm_available=True) is True
    assert defer_clause_to_llm("neon Tokyo", intent, llm_available=False) is False


def test_stock_showcase_stays_grammar_owned_when_keyed():
    intent = Intent(action="set_scene", mood="shine")
    assert defer_clause_to_llm("stock showcase", intent, llm_available=True) is False
    assert defer_clause_to_llm("product showcase", intent, llm_available=True) is True


def test_catalog_motion_forbidden_on_open_briefs():
    assert catalog_motion_forbidden("surprise me")
    assert catalog_motion_forbidden("animation goes crazy")
    assert not catalog_motion_forbidden("make the sphere bounce")
    assert said_literal_motion("bounce the ball")
    assert not said_literal_motion("animation goes crazy")
