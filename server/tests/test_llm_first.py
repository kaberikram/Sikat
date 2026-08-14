"""LLM-first parse integration tests."""
from __future__ import annotations

import asyncio

from app import llm
from app.agents.producer import Producer
from app.schema import Intent, PlacementAnchor, Target

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


async def test_deterministic_line_still_goes_to_the_llm(monkeypatch, scene):
    """The grammar can parse this one, but it is not the authority any more.

    It used to answer outright, which is why "add sphere beside the cube"
    spawned a box: the regex table matched `cube` before `sphere`.
    """
    stream_started = False

    async def fake_stream(text, scene, frame=None, on_partial=None, hints=None, tier="quality"):
        nonlocal stream_started
        stream_started = True
        yield Intent(action="spawn", primitive="box", color="#ff3b30")
        yield Intent(action="update_fx", section="bloom", fx_enabled=True)

    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(llm, "stream_intents", fake_stream)
    monkeypatch.setattr(llm, "select_provider", lambda frame=None: "deepseek")

    _, _, packets, logs, _ = await _collect_llm(
        Producer(), "add a red box then enable bloom", scene
    )
    assert stream_started
    assert not any(any(j in msg for j in _PARSE_JARGON) for msg in logs)
    assert any(p.command == "SPAWN_OBJECT" for p in packets)
    assert any(p.command == "UPDATE_FX" for p in packets)


async def test_the_crew_read_outranks_the_grammar_read(monkeypatch, scene):
    """Exactly one spawn reaches the set, and it is beside the cube.

    Grammar can parse this, but the keyed path asks the crew. Duplicate
    detection drops a second spawn if both answer.
    """
    async def fake_stream(text, scene, frame=None, on_partial=None, hints=None, tier="quality"):
        yield Intent(
            action="spawn",
            primitive="sphere",
            anchor=PlacementAnchor(target=Target(name="CUBE"), relation="beside"),
        )

    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(llm, "stream_intents", fake_stream)
    monkeypatch.setattr(llm, "select_provider", lambda frame=None: "deepseek")

    _, _, packets, _, _ = await _collect_llm(
        Producer(), "add sphere beside the cube", scene_with("CUBE")
    )
    spawns = [p for p in packets if p.command == "SPAWN_OBJECT"]
    assert len(spawns) == 1, "the grammar must not also spawn something"
    assert spawns[0].payload.primitive == "sphere"
    assert spawns[0].payload.anchor is not None
    assert spawns[0].payload.anchor.target.name == "CUBE"
    assert spawns[0].payload.anchor.relation == "beside"
    assert spawns[0].payload.position is None


async def test_put_a_cube_on_the_pedestal_goes_to_the_llm(monkeypatch):
    """Keyed path: the model owns the spawn. Salvage fills a dropped relation."""
    stream_started = False

    async def fake_stream(text, scene, frame=None, on_partial=None, hints=None, tier="quality"):
        nonlocal stream_started
        stream_started = True
        yield Intent(action="spawn", primitive="box", color="#ff3b30")

    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(llm, "stream_intents", fake_stream)
    monkeypatch.setattr(llm, "select_provider", lambda frame=None: "deepseek")

    _, _, packets, _, _ = await _collect_llm(
        Producer(), "put a red cube on the pedestal", scene_with("PEDESTAL")
    )
    spawns = [p for p in packets if p.command == "SPAWN_OBJECT"]
    assert stream_started is True
    assert len(spawns) == 1
    assert spawns[0].payload.anchor is not None
    assert spawns[0].payload.anchor.relation == "on"
    assert spawns[0].payload.anchor.target.name == "PEDESTAL"


async def test_place_a_box_left_of_sphere_uses_flat_anchor(monkeypatch):
    async def fake_stream(text, scene, frame=None, on_partial=None, hints=None, tier="quality"):
        yield Intent(
            action="spawn",
            primitive="box",
            anchor_target="CORE_SPHERE",
            anchor_relation="left_of",
        )

    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(llm, "stream_intents", fake_stream)
    monkeypatch.setattr(llm, "select_provider", lambda frame=None: "deepseek")

    _, _, packets, _, _ = await _collect_llm(
        Producer(),
        "place a box on the left of a sphere",
        scene_with("CORE_SPHERE"),
    )
    spawns = [p for p in packets if p.command == "SPAWN_OBJECT"]
    assert len(spawns) == 1
    assert spawns[0].payload.anchor is not None
    assert spawns[0].payload.anchor.relation == "left_of"
    assert spawns[0].payload.anchor.target.name == "CORE_SPHERE"
    assert spawns[0].payload.position is None


async def test_deterministic_line_is_instant_with_no_llm(monkeypatch, scene):
    """No key, no link: the grammar still runs the whole show, instantly."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.delenv("DIRECTOR_LLM_PROVIDER", raising=False)

    _, _, packets, _, _ = await _collect_llm(
        Producer(), "add a red box then enable bloom", scene
    )
    assert any(p.command == "SPAWN_OBJECT" for p in packets)
    assert any(p.command == "UPDATE_FX" for p in packets)


async def test_compound_line_adds_animate(monkeypatch, scene):
    async def fake_stream(text, scene, frame=None, on_partial=None, hints=None, tier="quality"):
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

    async def fake_stream(text, scene, frame=None, on_partial=None, hints=None, tier="quality"):
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

    async def fake_stream(text, scene, frame=None, on_partial=None, hints=None, tier="quality"):
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

    async def empty_stream(text, scene, frame=None, on_partial=None, hints=None, tier="quality"):
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
    async def fake_stream(text, scene, frame=None, on_partial=None, hints=None, tier="quality"):
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
    async def fake_stream(text, scene, frame=None, on_partial=None, hints=None, tier="quality"):
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
    async def fake_stream(text, scene, frame=None, on_partial=None, hints=None, tier="quality"):
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
    """Comma compound must not collapse to mood-only — every clause survives.

    The crew now owns the whole line rather than splitting it with the grammar,
    so the stream carries the spawns and the mood as well as the motion.
    """
    from app import performers, session_context

    performers.clear()
    session_context.clear()

    async def fake_stream(text, scene, frame=None, on_partial=None, hints=None, tier="quality"):
        yield Intent(action="spawn", primitive="box", color="#ff3b30")
        yield Intent(action="spawn", primitive="sphere", color="#0a84ff")
        yield Intent(action="animate", target="sphere", motion="bounce", addressee=1)
        yield Intent(action="animate", target="box", motion="orbit", addressee=2)
        yield Intent(action="set_scene", mood="sunset")

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
