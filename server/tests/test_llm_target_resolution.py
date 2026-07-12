"""Server-side LLM target resolution wired through Producer."""
from __future__ import annotations

from app.agents.producer import Producer
from app.schema import Intent
from app.session_context import SessionContext, bind_session, reset_session
from app.target_resolution import resolve_llm_target


def test_resolve_llm_target_sphere_to_core(scene):
    resolved, reason = resolve_llm_target("the sphere", scene)
    assert resolved == "CORE_SPHERE"
    assert reason == "fuzzy"


def test_resolve_llm_target_exact(scene):
    resolved, reason = resolve_llm_target("CORE_SPHERE", scene)
    assert resolved == "CORE_SPHERE"
    assert reason == "exact"


def test_resolve_llm_target_none(scene):
    resolved, reason = resolve_llm_target("thingamajig", scene)
    assert resolved is None
    assert reason == "none"


async def test_animate_nonsense_falls_back_to_hero(producer, scene):
    ctx = SessionContext()
    ctx.latest_scene = scene
    token = bind_session(ctx)
    logs: list[tuple[str, str]] = []

    async def emit(agent, message, level="info"):
        logs.append((level, message))

    packets = await producer._build_packets_for_intent(
        Intent(action="animate", target="thingamajig", motion="float"),
        emit=emit,
        command_id="t1",
        scene=scene,
    )
    reset_session(token)
    assert any(p.command == "ANIMATE_OBJECT" for p in packets)
    assert any("hero" in msg for _, msg in logs)


async def test_animate_no_target_emits_packets(producer, scene):
    ctx = SessionContext()
    ctx.latest_scene = scene
    token = bind_session(ctx)
    packets = await producer._build_packets_for_intent(
        Intent(action="animate", motion="bounce"),
        command_id="t2",
        scene=scene,
    )
    reset_session(token)
    assert any(p.command == "ANIMATE_OBJECT" for p in packets)


async def test_remove_nonsense_no_packets(producer, scene):
    ctx = SessionContext()
    ctx.latest_scene = scene
    token = bind_session(ctx)
    logs: list[tuple[str, str]] = []

    async def emit(agent, message, level="info"):
        logs.append((level, message))

    packets = await producer._build_packets_for_intent(
        Intent(action="remove", target="thingamajig"),
        emit=emit,
        command_id="t3",
        scene=scene,
    )
    reset_session(token)
    assert packets == []
    assert any("no match" in msg and level == "warn" for level, msg in logs)


async def test_spawn_suffix_target_untouched(producer, scene):
    ctx = SessionContext()
    ctx.latest_scene = scene
    token = bind_session(ctx)
    logs: list[str] = []

    async def emit(agent, message, level="info"):
        logs.append(message)

    # transform against a just-spawned name must not fuzzy-remap
    packets = await producer._build_packets_for_intent(
        Intent(action="transform", target="BOX_SPAWN", position=(1.0, 0.0, 0.0)),
        emit=emit,
        command_id="t4",
        scene=scene,
    )
    reset_session(token)
    assert not any("reading '" in msg for msg in logs)
    # BOX_SPAWN is not in scene — build yields nothing, but we did not remap
    assert packets == [] or all(
        getattr(getattr(p, "payload", None), "target", None) is None
        or getattr(p.payload.target, "name", None) == "BOX_SPAWN"
        for p in packets
    )
