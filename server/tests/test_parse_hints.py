"""Parse-hint prompt enrichment tests."""
from app.fallback_parser import parse_one_clause
from app.llm import _system_prompt
from app.parse_hints import format_parse_hints

from tests.helpers import scene_with


def test_hints_include_handled_marker():
    scene = scene_with("BOX")
    parsed = [("add a red box", parse_one_clause("add a red box", scene))]
    hints = format_parse_hints(parsed, scene, handled_indices={0})
    assert "SCRIPT SUPERVISOR NOTES" in hints
    assert "[handled — do not re-emit]" in hints
    assert "spawn" in hints


def test_hints_empty_when_nothing_parsed():
    hints = format_parse_hints([("xyzzy", None)], None, handled_indices=set())
    assert hints == ""


def test_system_prompt_embeds_hints():
    scene = scene_with("BOX")
    parsed = [("add a box", parse_one_clause("add a box", scene))]
    hints = format_parse_hints(parsed, scene, handled_indices={0})
    prompt = _system_prompt(scene, hints)
    assert "SCRIPT SUPERVISOR NOTES" in prompt
    assert "director's words always win" in prompt
