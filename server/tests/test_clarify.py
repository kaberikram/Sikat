"""Clarify-and-wait: ambiguous targets ask back before mutating."""
from __future__ import annotations

import pytest

from app import session_context
from app.fallback_parser import parse_one_clause
from app.session_context import PendingClarify
from app.target_resolution import is_ambiguous, rank_targets
from tests.helpers import scene_with


def test_rank_targets_finds_ambiguous_chairs():
    scene = scene_with("CHAIR_LEFT", "CHAIR_RIGHT")
    ranked = rank_targets("move the chair up", scene)
    assert len(ranked) >= 2
    assert is_ambiguous(ranked)


@pytest.mark.asyncio
async def test_move_chair_emits_question(producer):
    scene = scene_with("CHAIR_LEFT", "CHAIR_RIGHT")
    packets: list = []
    questions: list[dict] = []

    async def emit_packet(packet):
        packets.append(packet)

    async def emit_question(payload: dict):
        questions.append(payload)

    await producer.direct(
        "move the chair up 2",
        scene,
        "cmd-clarify",
        emit_packet=emit_packet,
        emit_question=emit_question,
    )

    assert packets == []
    assert len(questions) == 1
    assert questions[0]["type"] == "agent_question"
    assert "CHAIR_LEFT" in questions[0]["options"]
    assert "CHAIR_RIGHT" in questions[0]["options"]


@pytest.mark.asyncio
async def test_clarify_answer_resumes_move(producer):
    scene = scene_with("CHAIR_LEFT", "CHAIR_RIGHT")
    session_context.set_pending_clarify(
        PendingClarify(
            command_id="cmd-clarify",
            held_clauses=["move the chair up 2"],
            question="Which one?",
            options=["CHAIR_LEFT", "CHAIR_RIGHT"],
            agent="AssetAnimator",
        )
    )

    packets: list = []

    async def emit_packet(packet):
        packets.append(packet)

    await producer.direct(
        "CHAIR_LEFT",
        scene,
        "other-id",
        emit_packet=emit_packet,
    )

    assert len(packets) == 1
    assert packets[0].command == "TRANSFORM_OBJECT"
    assert packets[0].payload.target.name == "CHAIR_LEFT"


def test_parse_clause_clarify_intent():
    scene = scene_with("CHAIR_LEFT", "CHAIR_RIGHT")
    intent = parse_one_clause("move the chair up 2", scene)
    assert intent is not None
    assert intent.action == "clarify"
    assert intent.clarify_options is not None
    assert len(intent.clarify_options) >= 2
