"""Phase E — streaming partial intents per clause."""
from __future__ import annotations

import asyncio

from app import llm
from app.agents.producer import Producer
from app.schema import Intent


async def _collect(producer: Producer, text: str, scene):
    packets: list = []
    statuses: list[tuple[str, str]] = []
    events: list[tuple[str, str]] = []

    async def emit_log(agent, message, level="info"):
        return None

    async def emit_packet(packet):
        packets.append(packet)
        events.append(("packet", packet.command))

    async def emit_status(agent, status, command_id=None, note=None):
        statuses.append((agent, status))
        events.append(("status", f"{agent}:{status}"))

    planned, describe_only = await producer.direct(
        text, scene, "cmd-stream", emit_log, emit_packet, emit_status
    )
    return planned, describe_only, packets, statuses, events


async def test_spawn_packet_before_bloom(producer, scene):
    planned, _, packets, _, events = await _collect(
        producer, "add a red box then enable bloom", scene
    )
    assert [p.command for p in packets] == ["SPAWN_OBJECT", "UPDATE_FX"]
    spawn_idx = next(i for i, (kind, val) in enumerate(events) if val == "SPAWN_OBJECT")
    bloom_idx = next(i for i, (kind, val) in enumerate(events) if val == "UPDATE_FX")
    assert spawn_idx < bloom_idx
    assert planned[0].payload.color == "#ff3b30"
    assert planned[1].payload.section == "bloom"


async def test_fallback_clauses_stream_while_llm_pending(monkeypatch, scene):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    gate = asyncio.Event()
    released = asyncio.Event()

    async def slow_stream(text, scene, frame=None, on_partial=None, hints=None):
        gate.set()
        await released.wait()
        yield Intent(action="spawn", primitive="box", color="#ff3b30")
        yield Intent(action="update_fx", section="bloom", fx_enabled=True)

    monkeypatch.setattr(llm, "stream_intents", slow_stream)
    producer = Producer()

    packets: list = []
    events: list[str] = []

    async def emit_log(agent, message, level="info"):
        return None

    async def emit_packet(packet):
        packets.append(packet)
        events.append(packet.command)

    async def emit_status(agent, status, command_id=None, note=None):
        return None

    # First clause hits instant grammar; second does not — LLM stays pending.
    task = asyncio.create_task(
        producer.direct(
            "add a red box then xyzzy fuzz the mood",
            scene,
            "cmd-parallel",
            emit_log,
            emit_packet,
            emit_status,
        )
    )

    await asyncio.wait_for(gate.wait(), timeout=1.0)
    for _ in range(50):
        if events:
            break
        await asyncio.sleep(0.01)
    assert events[0] == "SPAWN_OBJECT", "fallback spawn should stream before LLM returns"
    assert not task.done()
    released.set()
    planned, describe_only = await task
    assert describe_only is False
    assert [p.command for p in packets] == ["SPAWN_OBJECT", "UPDATE_FX"]
    assert len(planned) == 2


def test_split_clauses_exported():
    from app.fallback_parser import split_clauses

    assert split_clauses("add a box then enable bloom") == [
        "add a box",
        "enable bloom",
    ]
    assert split_clauses("play; pause") == ["play", "pause"]
    assert split_clauses("add a blue sphere and make it wander") == [
        "add a blue sphere",
        "make it wander",
    ]
    assert split_clauses("black and white mood") == ["black and white mood"]


async def test_suggest_intent_routes_without_packets(monkeypatch, scene):
    suggestions: list = []
    packets: list = []

    async def fake_stream(text, scene, frame=None, on_partial=None, hints=None):
        yield Intent(action="spawn", primitive="box", color="#ff3b30", say="spawning box")
        yield Intent(
            action="suggest",
            say="want me to animate it?",
            suggestion_command="make the box bounce",
        )

    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(llm, "stream_intents", fake_stream)
    monkeypatch.setattr(llm, "select_provider", lambda frame=None: "deepseek")
    producer = Producer()

    async def emit_log(agent, message, level="info"):
        return None

    async def emit_packet(packet):
        packets.append(packet)

    async def emit_status(agent, status, command_id=None, note=None):
        return None

    async def emit_suggest(obs):
        suggestions.append(obs)

    await producer.direct(
        "add a creative box",
        scene,
        "cmd-suggest",
        emit_log,
        emit_packet,
        emit_status,
        emit_suggest=emit_suggest,
    )
    assert len(suggestions) == 1
    assert suggestions[0].kind == "command_suggest"
    assert suggestions[0].suggested_command == "make the box bounce"
