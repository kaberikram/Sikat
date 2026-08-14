"""Clause routing — grammar vs LLM ownership."""
from app.creative_parse import defer_clause_to_llm, is_llm_owned_clause
from app.fallback_parser import parse_one_clause

from tests.helpers import scene_with


def test_spawn_defers_when_llm_available():
    """A spawn belongs to the crew that can read a sentence — keyed path."""
    scene = scene_with("BOX")
    intent = parse_one_clause("add a red box", scene)
    assert intent is not None
    assert defer_clause_to_llm("add a red box", intent, llm_available=True) is True
    assert is_llm_owned_clause("add a red box", intent, llm_available=True) is True


def test_anchored_spawn_defers_when_llm_available():
    """'On the pedestal' still goes to the model when a key is set.

    Grammar can parse it, but it is not the authority. Flattened
    `anchor_target` / `anchor_relation` (and salvage) are how the relation
    survives, not a regex intercept.
    """
    scene = scene_with("PEDESTAL")
    intent = parse_one_clause("put a red cube on the pedestal", scene)
    assert intent is not None
    assert intent.anchor is not None
    assert defer_clause_to_llm(
        "put a red cube on the pedestal", intent, llm_available=True
    ) is True


def test_spawn_grammar_owned_with_no_llm():
    scene = scene_with("BOX")
    intent = parse_one_clause("add a red box", scene)
    assert intent is not None
    assert defer_clause_to_llm("add a red box", intent, llm_available=False) is False


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


def test_fx_toggle_grammar_owned_when_llm_available():
    """Simple on/off is instant — no magnitude to infer."""
    intent = parse_one_clause("enable bloom", None)
    assert intent is not None
    assert intent.action == "update_fx"
    assert not intent.fx_set
    assert defer_clause_to_llm("enable bloom", intent, llm_available=True) is False


def test_fx_complaint_defers_when_llm_available():
    """'Too much bloom' writes fx_set — the model owns the magnitude."""
    intent = parse_one_clause("too much bloom", None)
    assert intent is not None
    assert intent.action == "update_fx"
    assert intent.fx_set
    assert defer_clause_to_llm("too much bloom", intent, llm_available=True) is True


def test_fx_grammar_owned_with_no_llm():
    intent = parse_one_clause("enable bloom", None)
    assert intent is not None
    assert defer_clause_to_llm("enable bloom", intent, llm_available=False) is False
