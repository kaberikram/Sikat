"""Empty-plan recovery: motion floor emit arity + recovery-cap budget."""
from __future__ import annotations

from app import llm
from app.agents.planner import PlanRunner
from app.agents.producer import Producer
from app.schema import PlanStep
from app.session_context import SessionContext, bind_session, reset_session


async def test_motion_floor_emit_packet_single_arg(monkeypatch, scene):
    """Empty stream_plan → motion floor packets; emit_packet takes one arg only."""

    async def empty_plan(*args, **kwargs):
        if False:
            yield None  # pragma: no cover — make this an async generator

    monkeypatch.setattr(llm, "stream_plan", empty_plan)

    ctx = SessionContext()
    ctx.latest_scene = scene
    token = bind_session(ctx)
    packets: list = []

    async def emit_log(agent, message, level="info"):
        return None

    async def emit_packet(packet):
        packets.append(packet)

    async def emit_status(agent, status, command_id=None, note=None):
        return None

    async def emit_cancel(*args, **kwargs):
        return None

    async def emit_suggest(*args, **kwargs):
        return None

    async def emit_question(*args, **kwargs):
        return None

    async def emit_plan_update(*args, **kwargs):
        return None

    await PlanRunner(Producer()).run(
        "bounce the ball",
        scene,
        "cmd-1",
        emit_log,
        emit_packet,
        emit_status,
        None,
        emit_cancel,
        emit_suggest,
        emit_question,
        emit_plan_update,
        prefer_strong=True,
    )
    reset_session(token)

    assert any(p.command == "ANIMATE_OBJECT" for p in packets)
    assert any(p.command == "PLAYBACK" for p in packets)
    assert packets[0].commandId == "cmd-1"


async def test_recovery_cap_accepts_spawn_after_failed_plan(monkeypatch, scene):
    """Failed plan filling all_steps must not collapse recovery budget to 0."""
    calls: list[dict] = []

    async def scripted_plan(
        text, scene_arg, frame=None, *, tier="fast", extra_context=None, adjustment=False
    ):
        calls.append({"extra_context": extra_context, "adjustment": adjustment})
        is_recovery = extra_context is not None and "ZERO executable steps" in extra_context
        if is_recovery:
            yield llm.Step(
                PlanStep(action="spawn", primitive="box", color="#ff3b30", say="box in")
            )
            return
        for _ in range(6):
            yield llm.Step(PlanStep(action="transform", say="noop"))

    monkeypatch.setattr(llm, "stream_plan", scripted_plan)

    ctx = SessionContext()
    ctx.latest_scene = scene
    token = bind_session(ctx)
    packets: list = []

    async def emit_log(agent, message, level="info"):
        return None

    async def emit_packet(packet):
        packets.append(packet)

    async def emit_status(agent, status, command_id=None, note=None):
        return None

    async def emit_cancel(*args, **kwargs):
        return None

    async def emit_suggest(*args, **kwargs):
        return None

    async def emit_question(*args, **kwargs):
        return None

    async def emit_plan_update(*args, **kwargs):
        return None

    await PlanRunner(Producer()).run(
        "bounce the ball",
        scene,
        "cmd-2",
        emit_log,
        emit_packet,
        emit_status,
        None,
        emit_cancel,
        emit_suggest,
        emit_question,
        emit_plan_update,
        prefer_strong=True,
    )
    reset_session(token)

    assert any(
        c.get("extra_context") and "ZERO executable steps" in (c["extra_context"] or "")
        for c in calls
    )
    assert any(p.command == "SPAWN_OBJECT" for p in packets)
