"""Focused tests for the DirectorPlan streaming primitives."""
from app import llm
from app.schema import PlanStep


def test_extract_steps_ignores_arrays_before_steps():
    buffer = (
        '{"example":[{"ignore":true}],"steps":['
        '{"action":"animate","target":"BALL","track_property":"position",'
        '"track_keyframes":[{"time":0,"value":[0,0,0]}]}]}'
    )
    slices, consumed = llm.extract_complete_array_items(buffer, 0)
    assert len(slices) == 1
    assert PlanStep.model_validate_json(slices[0]).target == "BALL"
    assert llm.extract_complete_array_items(buffer, consumed)[0] == []


def test_extract_steps_waits_for_closed_object():
    slices, consumed = llm.extract_complete_array_items(
        '{"steps":[{"action":"spawn","primitive":"box"', 0
    )
    assert slices == []
    assert consumed == 0
