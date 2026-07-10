"""LLM-first parse integration tests."""
from __future__ import annotations

import asyncio

from app import llm
from app.agents.producer import Producer
from app.schema import Intent

from tests.helpers import scene_with

_PARSE_JARGON = (
    "LLM idle",
    "grammar handled",
    "defer → LLM",
    "assigning:",
    "streaming ",
    "via fallback",
)


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


async def test_pure_deterministic_skips_llm(monkeypatch, scene):
    stream_started = False

    async def slow_stream(text, scene, frame=None, on_partial=None, hints=None):
        nonlocal stream_started
        stream_started = True
        yield Intent(action="spawn", primitive="box", color="#ff3b30")

    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(llm, "stream_intents", slow_stream)
    monkeypatch.setattr(llm, "select_provider", lambda frame=None: "deepseek")

    _, _, packets, logs, _ = await _collect_llm(
        Producer(), "add a red box then enable bloom", scene
    )
    assert not stream_started
    assert not any(any(j in msg for j in _PARSE_JARGON) for msg in logs)
    assert any(p.command == "SPAWN_OBJECT" for p in packets)
    assert any(p.command == "UPDATE_FX" for p in packets)


async def test_compound_line_adds_animate(monkeypatch, scene):
    async def fake_stream(text, scene, frame=None, on_partial=None, hints=None):
        yield Intent(action="spawn", primitive="sphere", color="#3366ff")
        yield Intent(action="animate", target="CORE_SPHERE", motion="wander")

    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(llm, "stream_intents", fake_stream)
    monkeypatch.setattr(llm, "select_provider", lambda frame=None: "deepseek")

    _, _, packets, logs, _ = await _collect_llm(
        Producer(),
        "add a blue sphere and make it wander",
        scene,
    )
    commands = [p.command for p in packets]
    assert commands.count("SPAWN_OBJECT") == 1
    assert "ANIMATE_OBJECT" in commands
    assert not any(any(j in msg for j in _PARSE_JARGON) for msg in logs)


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
    assert not any(any(j in msg for j in _PARSE_JARGON) for msg in logs)


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


async def test_duplicate_llm_spawn_dropped(monkeypatch, scene):
    async def fake_stream(text, scene, frame=None, on_partial=None, hints=None):
        yield Intent(
            action="spawn",
            primitive="box",
            color="#ff3b30",
            say="red box, dead center",
        )
        yield Intent(action="animate", target="it", motion="bounce")

    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(llm, "stream_intents", fake_stream)
    monkeypatch.setattr(llm, "select_provider", lambda frame=None: "deepseek")

    _, _, packets, logs, _ = await _collect_llm(
        Producer(), "add a red box and bounce it", scene
    )
    assert sum(1 for p in packets if p.command == "SPAWN_OBJECT") == 1
    assert "red box, dead center" in logs
    assert any(p.command == "ANIMATE_OBJECT" for p in packets)


async def test_showcase_comma_line_emits_spawns_and_animates(monkeypatch, scene):
    """Comma compound must not collapse to mood-only; motion clauses reach the LLM."""
    from app import performers, session_context

    performers.clear()
    session_context.clear()

    async def fake_stream(text, scene, frame=None, on_partial=None, hints=None):
        yield Intent(action="animate", target="sphere", motion="bounce", addressee=1)
        yield Intent(action="animate", target="box", motion="orbit", addressee=2)

    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(llm, "stream_intents", fake_stream)
    monkeypatch.setattr(llm, "select_provider", lambda frame=None: "deepseek")

    showcase = (
        "add a red box and a blue sphere, Agent 1 you're on the sphere, "
        "Agent 2 you're on the box, Agent 1 bounce high, Agent 2 orbit, "
        "sunset mood, enable bloom"
    )
    _, _, packets, _, _ = await _collect_llm(Producer(), showcase, scene)
    commands = [p.command for p in packets]
    assert commands.count("SPAWN_OBJECT") == 2
    assert commands.count("ANIMATE_OBJECT") == 2
    assert "UPDATE_LIGHTS" in commands
    agents = {p.target_agent for p in packets if p.command == "ANIMATE_OBJECT"}
    assert agents == {"Agent1", "Agent2"}
