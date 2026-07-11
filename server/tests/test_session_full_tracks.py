"""Tests for session full-tracks retention and heartbeat merge."""
from __future__ import annotations

import pytest

from app.scene_context import format_scene_brief
from app.schema import KeyframeTrackSummary
from app.session_context import SessionContext
from tests.helpers import scene_kw, animated_sphere_scene


@pytest.fixture
def session():
    return SessionContext()


def test_heartbeat_merges_full_tracks_from_full_snapshot(session):
    full = animated_sphere_scene()
    session.update_scene(full)

    # Create a heartbeat with only summaries (deep copy to avoid sharing objects)
    heartbeat = full.model_copy(update={"mode": "heartbeat"}, deep=True)
    heartbeat.objects[0].tracks = [
        KeyframeTrackSummary(property="position", keyframeCount=6)
    ]
    session.update_scene(heartbeat)

    merged = session.latest_scene
    assert merged is not None
    # The merged scene should have full tracks substituted back, which
    # format_scene_brief surfaces as a detailed summary (time range + Y range)
    brief = format_scene_brief(merged)
    assert "0.0–5.0s" in brief
    assert "Y range" in brief


def test_full_snapshot_stored_separately(session):
    full = animated_sphere_scene()
    session.update_scene(full)
    assert session.latest_full_scene is not None
    assert session.latest_full_scene.mode == "full"


def test_heartbeat_without_full_snapshot_no_merge(session):
    heartbeat = animated_sphere_scene().model_copy(update={"mode": "heartbeat"})
    session.update_scene(heartbeat)
    assert session.latest_scene is not None
    assert session.latest_full_scene is None
