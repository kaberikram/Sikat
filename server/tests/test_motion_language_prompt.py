"""Contract tests for the motion-language (craft vocabulary) prompt additions."""

from app.llm import _system_prompt
from app.prompts import build_plan_prompt


def test_intent_prompt_has_motion_language_section():
    prompt = _system_prompt(None)
    assert "Motion language" in prompt
    assert "fade in/out" in prompt
    assert "anticipation" in prompt
    assert "follow-through" in prompt


def test_core_prompt_has_craft_defaults_on_every_tier():
    for tier in ("fast", "strong"):
        prompt = build_plan_prompt(None, "", tier=tier)
        assert "Craft defaults" in prompt
        assert "ease out" in prompt
        assert "stagger" in prompt


def test_strong_prompt_teaches_anticipation_and_follow_through():
    prompt = build_plan_prompt(None, "", tier="strong")
    assert "anticipation" in prompt
    assert "follow-through" in prompt
    assert "fast out" in prompt


def test_fast_prompt_stays_lean():
    prompt = build_plan_prompt(None, "", tier="fast")
    assert "follow-through" not in prompt


def test_craft_lines_do_not_weaken_bare_animate_policy():
    prompt = build_plan_prompt(None, "", tier="strong")
    assert "Do NOT pick a motion id for bare animate" in prompt


def test_scene_agent_system_has_motion_craft():
    from app.agents.scene_agent import AGENT_SYSTEM

    assert "Motion craft" in AGENT_SYSTEM
    assert "follow-through" in AGENT_SYSTEM
