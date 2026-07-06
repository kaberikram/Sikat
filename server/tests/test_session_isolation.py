"""Per-connection session isolation and reference resolution."""
from __future__ import annotations

import pytest

from app import session_context
from app.fallback_parser import parse_one_clause
from app.schema import MaterialOverrideSnapshot
from app.session_context import SessionContext, bind_session, reset_session
from app.target_resolution import rank_targets
from tests.helpers import scene_with


def test_session_isolation_via_contextvar():
    a = SessionContext()
    b = SessionContext()
    token_a = bind_session(a)
    session_context.record("move the box up 2", [])
    reset_session(token_a)

    token_b = bind_session(b)
    assert session_context.last_target() is None
    reset_session(token_b)

    assert session_context.last_target() is None


def test_color_reference_resolution():
    scene = scene_with("RED_CHAIR", "BLUE_CHAIR")
    for obj in scene.objects:
        if "RED" in obj.name:
            obj.materialOverride = MaterialOverrideSnapshot(color="#ff3b30")
        else:
            obj.materialOverride = MaterialOverrideSnapshot(color="#0a84ff")
    ranked = rank_targets("move the red one up", scene)
    assert len(ranked) == 1
    assert ranked[0][0] == "RED_CHAIR"


def test_spatial_left_reference():
    scene = scene_with("OBJ_LEFT", "OBJ_RIGHT")
    scene.objects[0].sampled.position = (-3.0, 0.0, 0.0)
    scene.objects[1].sampled.position = (3.0, 0.0, 0.0)
    scene.virtualCamera.sampled.position = (0.0, 2.0, 5.0)
    scene.virtualCamera.rotation = (0.0, 0.0, 0.0)
    ranked = rank_targets("move the one on the left", scene)
    assert ranked[0][0] == "OBJ_LEFT"


def test_chatter_novelty():
    ctx = SessionContext()
    token = bind_session(ctx)
    notes = [ctx.pick_fresh_note(["copy", "on it", "yep"]) for _ in range(3)]
    assert len(set(notes)) == 3
    reset_session(token)


def test_parse_red_one_target():
    scene = scene_with("RED_BOX", "BLUE_BOX")
    scene.objects[0].materialOverride = MaterialOverrideSnapshot(color="#ff3b30")
    scene.objects[1].materialOverride = MaterialOverrideSnapshot(color="#0a84ff")
    intent = parse_one_clause("move the red one up 2", scene)
    assert intent is not None
    assert intent.action == "transform"
    assert intent.target == "RED_BOX"
