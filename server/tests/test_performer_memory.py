"""Phase 5 — per-performer memory + persona."""
from __future__ import annotations

from app.agents.producer import Producer
from app import performers
from app.schema import Intent

from tests.helpers import scene_with


def setup_function():
    performers.clear()


def test_assign_starts_with_empty_recent():
    performers.assign(2, "CORE_SPHERE")
    assert list(performers.get(2).recent) == []


def test_record_action_appends_to_recent():
    performers.assign(2, "CORE_SPHERE")
    performers.record_action(2, "animate CORE_SPHERE bounce hops=3 height=2.5")
    assert list(performers.get(2).recent) == ["animate CORE_SPHERE bounce hops=3 height=2.5"]


def test_record_action_caps_at_max_recent():
    performers.assign(2, "CORE_SPHERE")
    for i in range(10):
        performers.record_action(2, f"action {i}")
    assert len(performers.get(2).recent) == 5
    assert list(performers.get(2).recent) == [f"action {i}" for i in range(5, 10)]


def test_record_action_noop_for_unassigned_performer():
    performers.record_action(3, "should be dropped")
    assert performers.get(3) is None


def test_persona_table():
    assert performers.persona(1) == "precise, minimal"
    assert performers.persona(2) == "playful, big moves"
    assert performers.persona(3) == "moody, dramatic"
    assert performers.persona(4) == "fast, energetic"
    assert performers.persona(5) is None


def test_brief_includes_persona_and_recent():
    performers.assign(2, "CORE_SPHERE")
    performers.record_action(2, "bounce ×3 high")
    performers.record_action(2, "scale up 1.5")
    text = performers.brief()
    assert "Agent 2 → CORE_SPHERE" in text
    assert "playful, big moves" in text
    assert "bounce ×3 high" in text
    assert "scale up 1.5" in text


async def test_producer_records_action_for_addressed_transform(producer: Producer):
    scene = scene_with("CORE_SPHERE")
    performers.assign(1, "CORE_SPHERE")

    async def emit_log(agent, message, level="info"):
        return None

    intent = Intent(action="transform", addressee=1, position=(0, 2, 0))
    built = await producer._build_packets_for_intent(intent, emit_log, scene=scene)
    assert built
    assert performers.get(1).recent
    assert "transform" in performers.get(1).recent[-1]
