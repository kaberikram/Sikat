"""Plan prompt constraints — no showcase beat recipe, authored keyframes required."""
from app.prompts import CORE_PROMPT, STRONG_ADDENDUM
from app.llm import SYSTEM_PROMPT_TEMPLATE


def test_core_prompt_has_no_showcase_recipe():
    for blob in (CORE_PROMPT, SYSTEM_PROMPT_TEMPLATE):
        assert "Beat recipe" not in blob
        assert "title card" not in blob.lower()
        assert 'default "RADIO_EDIT"' not in blob
    assert "stock beat list" in CORE_PROMPT
    assert "track_keyframes" in CORE_PROMPT


def test_strong_addendum_requires_authored_keyframes():
    assert "MUST author track_keyframes" in STRONG_ADDENDUM
    assert "catalog shortcut" in STRONG_ADDENDUM
