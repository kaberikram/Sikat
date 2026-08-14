"""Plan prompt constraints — no showcase beat recipe, authored keyframes required."""
from app.prompts import CORE_PROMPT, MOTION_CRAFT_ADDENDUM, SPATIAL_ADDENDUM, STRONG_ADDENDUM
from app.llm import SYSTEM_PROMPT_TEMPLATE, _system_prompt


def test_core_prompt_has_no_showcase_recipe():
    for blob in (CORE_PROMPT, SYSTEM_PROMPT_TEMPLATE):
        assert "Beat recipe" not in blob
        assert "title card" not in blob.lower()
        assert 'default "RADIO_EDIT"' not in blob
    assert "stock beat list" in CORE_PROMPT
    assert "track_keyframes" in CORE_PROMPT
    assert "anchor_target" in CORE_PROMPT
    assert "left_of" in CORE_PROMPT
    assert "anchor_target" in SYSTEM_PROMPT_TEMPLATE or "spatial_addendum" in SYSTEM_PROMPT_TEMPLATE


def test_stream_prompt_embeds_spatial_addendum():
    prompt = _system_prompt(None)
    assert "anchor_target" in prompt
    assert "left_of" in prompt
    assert "anchor_target" in SPATIAL_ADDENDUM


def test_motion_craft_addendum_on_both_prompts():
    prompt = _system_prompt(None)
    assert "Canonical ids:" in MOTION_CRAFT_ADDENDUM
    assert "bounce" in MOTION_CRAFT_ADDENDUM
    assert "pop in" in MOTION_CRAFT_ADDENDUM
    assert "track_keyframes" in MOTION_CRAFT_ADDENDUM
    assert MOTION_CRAFT_ADDENDUM in CORE_PROMPT
    assert "Canonical ids:" in prompt
    assert "pop in" in prompt
    assert "{motion_craft_addendum}" in SYSTEM_PROMPT_TEMPLATE


def test_strong_addendum_requires_authored_keyframes():
    assert "MUST author track_keyframes" in STRONG_ADDENDUM
    assert "catalog shortcut" in STRONG_ADDENDUM
