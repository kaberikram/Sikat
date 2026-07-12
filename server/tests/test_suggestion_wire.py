"""WebSocket integration: proactive crew agent_suggestion."""
from __future__ import annotations

import os
import time

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.schema import ObjectSnapshot, SampledTransform, SceneState


def _scene_payload(**kwargs) -> dict:
    scene = SceneState(**kwargs)
    return scene.model_dump()


def _heartbeat(objects: list[ObjectSnapshot]) -> dict:
    return _scene_payload(
        mode="heartbeat",
        objects=objects,
        stage={"position": [0, 0, 0], "radius": 1.0},
    )


@pytest.fixture(autouse=True)
def _enable_proactive(monkeypatch):
    monkeypatch.setenv("DIRECTOR_PROACTIVE", "1")


def test_off_stage_triggers_suggestion():
    on_stage = ObjectSnapshot(
        id="id0",
        name="BOX",
        sampled=SampledTransform(
            position=(0.0, 0.0, 0.0), rotation=(0, 0, 0), scale=(1, 1, 1)
        ),
    )
    off_stage = ObjectSnapshot(
        id="id0",
        name="BOX",
        sampled=SampledTransform(
            position=(30.0, 0.0, 30.0), rotation=(0, 0, 0), scale=(1, 1, 1)
        ),
    )
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            ws.send_json(_heartbeat([on_stage]))
            time.sleep(0.05)
            ws.send_json(_heartbeat([off_stage]))
            deadline = time.time() + 5.0
            seen_suggestion = False
            while time.time() < deadline:
                msg = ws.receive_json()
                if msg.get("type") == "agent_suggestion":
                    seen_suggestion = True
                    assert msg["agent"] == "AssetAnimator"
                    assert "BOX" in msg["text"] or msg.get("subjectObject") == "BOX"
                    break
            assert seen_suggestion, "expected agent_suggestion for off-stage object"


def test_cooldown_suppresses_repeat():
    on_stage = ObjectSnapshot(
        id="id0",
        name="BOX",
        sampled=SampledTransform(
            position=(0.0, 0.0, 0.0), rotation=(0, 0, 0), scale=(1, 1, 1)
        ),
    )
    off = ObjectSnapshot(
        id="id0",
        name="BOX",
        sampled=SampledTransform(
            position=(30.0, 0.0, 30.0), rotation=(0, 0, 0), scale=(1, 1, 1)
        ),
    )
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            ws.send_json(_heartbeat([on_stage]))
            time.sleep(0.05)
            ws.send_json(_heartbeat([off]))
            time.sleep(0.7)
            first = None
            deadline = time.time() + 5.0
            while time.time() < deadline:
                msg = ws.receive_json()
                if msg.get("type") == "agent_suggestion":
                    first = msg
                    break
            assert first is not None
            # Clear condition then re-trigger — gate should block within cooldown
            ws.send_json(_heartbeat([on_stage]))
            time.sleep(0.05)
            ws.send_json(_heartbeat([off]))
            time.sleep(0.7)
