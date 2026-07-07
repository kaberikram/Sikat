"""LLM-first parse integration tests."""
from __future__ import annotations

import asyncio

from app import llm
from app.agents.producer import Producer
from app.schema import Intent

from tests.helpers import scene_with


async def _collect_llm(producer, text, scene, *, emit_cancel=None):
    packets: list = []
    logs: list[str] = []
    cancels: list[dict] = []

    async def emit_log(agent, message, level="info"):
        logs.append(message)

    async def emit_packet(packet):
        packets.append(packet)

    async def emit_status(agent, status, command_id=None, note=None):
        return None

    async def emit_cancel_fn(payload: dict):
        cancels.append(payload)

    planned, describe_only = await producer.direct(
        text,
        scene,
        "cmd-llm-first",
        emit_log,
        emit_packet,
        emit_status,
        emit_cancel=emit_cancel or emit_cancel_fn,
    )
    return planned, describe_only, packets, logs, cancels


async def test_llm_not_cancelled_on_full_grammar_match(monkeypatch, scene):
    completed = asyncio.Event()

    async def slow_stream(text, scene, frame=None, on_partial=None, hints=None):
        try:
            yield Intent(action="spawn", primitive="box", color="#ff3b30")
        finally:
            completed.set()

    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(llm, "stream_intents", slow_stream)
    monkeypatch.setattr(llm, "select_provider", lambda frame=None: "deepseek")

    _, _, packets, logs, _ = await _collect_llm(
        Producer(), "add a red box then enable bloom", scene
    )
    await asyncio.wait_for(completed.wait(), timeout=2.0)
    assert any("staged" in msg and "LLM confirmed" in msg for msg in logs)
    assert "LLM skipped" not in " ".join(logs)
    assert any(p.command == "SPAWN_OBJECT" for p in packets)


async def test_compound_line_adds_animate(monkeypatch, scene):
    async def fake_stream(text, scene, frame=None, on_partial=None, hints=None):
        yield Intent(action="spawn", primitive="sphere", color="#3366ff")
        yield Intent(action="animate", target="CORE_SPHERE", motion="wander")

    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(llm, "stream_intents", fake_stream)
    monkeypatch.setattr(llm, "select_provider", lambda frame=None: "deepseek")

    _, _, packets, _, _ = await _collect_llm(
        Producer(),
        "add a blue sphere and make it wander",
        scene,
    )
    commands = [p.command for p in packets]
    assert commands.count("SPAWN_OBJECT") == 1
    assert "ANIMATE_OBJECT" in commands


async def test_llm_animate_no_grammar_staging(monkeypatch, scene):
    box_scene = scene_with("BOX")

    async def fake_stream(text, scene, frame=None, on_partial=None, hints=None):
        yield Intent(action="animate", target="BOX", motion="wander")

    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(llm, "stream_intents", fake_stream)
    monkeypatch.setattr(llm, "select_provider", lambda frame=None: "deepseek")

    _, _, packets, logs, cancels = await _collect_llm(
        Producer(), "bounce the box", box_scene
    )
    assert not any(c.get("reason") == "amend" for c in cancels)
    animate = [p for p in packets if p.command == "ANIMATE_OBJECT"]
    assert len(animate) == 1
    assert animate[0].refinement is False
    assert any("defer → LLM" in msg for msg in logs)


async def test_llm_animate_emits_fresh_not_refinement(monkeypatch, scene):
    box_scene = scene_with("BOX")

    async def fake_stream(text, scene, frame=None, on_partial=None, hints=None):
        yield Intent(
            action="animate",
            target="BOX",
            motion="bounce",
            motion_params={"hops": 10},
        )

    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(llm, "stream_intents", fake_stream)
    monkeypatch.setattr(llm, "select_provider", lambda frame=None: "deepseek")

    _, _, packets, _, _ = await _collect_llm(
        Producer(), "bounce the box", box_scene
    )
    animate = [p for p in packets if p.command == "ANIMATE_OBJECT"]
    assert len(animate) == 1
    assert animate[0].refinement is False


async def test_all_deferred_llm_empty_triggers_grammar_rescue(monkeypatch, scene):
    box_scene = scene_with("BOX")

    async def empty_stream(text, scene, frame=None, on_partial=None, hints=None):
        if False:
            yield Intent(action="animate", target="BOX", motion="wander")

    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(llm, "stream_intents", empty_stream)
    monkeypatch.setattr(llm, "select_provider", lambda frame=None: "deepseek")

    _, _, packets, logs, _ = await _collect_llm(
        Producer(), "bounce the box", box_scene
    )
    assert any("rule-parser rescue" in msg for msg in logs)
    assert any(p.command == "ANIMATE_OBJECT" for p in packets)


async def test_spawn_color_mismatch_no_set_material(monkeypatch, scene):
    async def fake_stream(text, scene, frame=None, on_partial=None, hints=None):
        yield Intent(action="spawn", primitive="sphere", color="#ff0000")

    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(llm, "stream_intents", fake_stream)
    monkeypatch.setattr(llm, "select_provider", lambda frame=None: "deepseek")

    _, _, packets, _, _ = await _collect_llm(
        Producer(), "add a blue sphere", scene
    )
    commands = [p.command for p in packets]
    assert commands.count("SPAWN_OBJECT") == 1
    assert "SET_MATERIAL" not in commands


async def test_compound_wander_targets_spawned_sphere(monkeypatch, scene):
    async def fake_stream(text, scene, frame=None, on_partial=None, hints=None):
        yield Intent(action="spawn", primitive="sphere", color="#0a84ff")
        yield Intent(action="animate", target="it", motion="wander")

    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(llm, "stream_intents", fake_stream)
    monkeypatch.setattr(llm, "select_provider", lambda frame=None: "deepseek")

    _, _, packets, _, _ = await _collect_llm(
        Producer(),
        "add a blue sphere and make it wander",
        scene,
    )
    spawn = next(p for p in packets if p.command == "SPAWN_OBJECT")
    animate = next(p for p in packets if p.command == "ANIMATE_OBJECT")
    assert spawn.payload.name == "SPHERE_SPAWN"
    assert animate.payload.target.name == "SPHERE_SPAWN"


async def test_duplicate_say_surfaces(monkeypatch, scene):
    async def fake_stream(text, scene, frame=None, on_partial=None, hints=None):
        yield Intent(
            action="spawn",
            primitive="box",
            color="#ff3b30",
            say="red box, dead center",
        )

    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(llm, "stream_intents", fake_stream)
    monkeypatch.setattr(llm, "select_provider", lambda frame=None: "deepseek")

    _, _, packets, logs, _ = await _collect_llm(
        Producer(), "add a red box", scene
    )
    assert any(p.command == "SPAWN_OBJECT" for p in packets)
    assert "red box, dead center" in logs
