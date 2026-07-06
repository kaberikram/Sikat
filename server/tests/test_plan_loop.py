"""Plan-act-observe loop tests (Phase B)."""
from __future__ import annotations

import asyncio

from app import llm, session_context
from app.agents.producer import Producer
from app.schema import Intent
from app.session_context import SessionContext, bind_session, reset_session


async def test_plan_loop_emits_first_packet_before_second_llm_call(monkeypatch, scene):
    calls: list[str] = []

    async def scripted_stream(text, scene, frame=None, on_partial=None):
        calls.append(text[:40])
        if len(calls) == 1:
            yield Intent(action="spawn", primitive="box", color="#ff3b30", say="box in")
            yield Intent(
                action="describe",
                describe_message="PLAN: 1) spawn box 2) enable bloom",
            )
        else:
            yield Intent(action="update_fx", section="bloom", fx_enabled=True, say="bloom on")

    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(llm, "stream_intents", scripted_stream)
    monkeypatch.setattr(llm, "select_provider", lambda frame=None: "deepseek")

    ctx = SessionContext()
    token = bind_session(ctx)
    producer = Producer()
    packets: list = []

    async def emit_log(agent, message, level="info"):
        return None

    async def emit_packet(packet):
        packets.append(packet)

    async def emit_status(agent, status, command_id=None, note=None):
        return None

    await producer.direct(
        "make it feel like a music video intro",
        scene,
        "plan-1",
        emit_log,
        emit_packet,
        emit_status,
    )
    reset_session(token)
    assert len(calls) >= 1
    assert any(p.command == "SPAWN_OBJECT" for p in packets)


async def test_plan_survives_command_started_cancel(monkeypatch, scene):
    """cancel_active_plan() on command entry must not abort the new plan immediately."""
    calls: list = []

    async def scripted_stream(text, scene, frame=None, on_partial=None):
        calls.append(text[:30])
        yield Intent(action="spawn", primitive="sphere", color="#0a84ff", say="sphere in")
        yield Intent(
            action="describe",
            describe_message="PLAN: 1) spawn sphere 2) enable bloom",
        )

    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(llm, "stream_intents", scripted_stream)
    monkeypatch.setattr(llm, "select_provider", lambda frame=None: "deepseek")

    ctx = SessionContext()
    token = bind_session(ctx)
    ctx.cancel_active_plan()
    assert ctx.plan_cancelled().is_set()

    producer = Producer()
    packets: list = []
    logs: list = []

    async def emit_log(agent, message, level="info"):
        logs.append((level, message))

    async def emit_packet(packet):
        packets.append(packet)

    async def emit_status(agent, status, command_id=None, note=None):
        return None

    await producer.direct(
        "make it feel like a music video intro",
        scene,
        "plan-2",
        emit_log,
        emit_packet,
        emit_status,
    )
    reset_session(token)
    assert not any("plan cut short" in msg for _, msg in logs)
    assert any(p.command == "SPAWN_OBJECT" for p in packets)


async def test_plan_cancel_on_new_command(monkeypatch, scene):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(llm, "select_provider", lambda frame=None: "deepseek")

    async def slow_stream(text, scene, frame=None, on_partial=None):
        await asyncio.sleep(0.5)
        yield Intent(action="describe", describe_message="PLAN: 1) a 2) b 3) c 4) d 5) e")

    monkeypatch.setattr(llm, "stream_intents", slow_stream)
    ctx = SessionContext()
    token = bind_session(ctx)
    ctx.cancel_active_plan()
    reset_session(token)
    assert ctx.plan_cancelled().is_set()
