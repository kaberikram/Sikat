"""Partial preview field extraction from streaming LLM JSON."""
from app.llm import extract_partial_preview_fields


def test_extract_partial_fields():
    buffer = '{"intents": [{"action": "animate", "target": "CORE_SPHERE", "addressee": 1'
    fields = extract_partial_preview_fields(buffer)
    assert fields is not None
    assert fields["action"] == "animate"
    assert fields["target"] == "CORE_SPHERE"
    assert fields["addressee"] == 1


def test_extract_requires_two_fields():
    assert extract_partial_preview_fields('{"intents": [{"action": "animate"') is None
