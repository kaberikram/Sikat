"""Phase 4 — LLM-generated `say` chatter rides with the intent, no extra calls."""
from __future__ import annotations

from app.agents.producer import Producer
from app.schema import Intent

from tests.helpers import scene_with


async def _collect(producer: Producer, intents: list[Intent], scene):
    statuses: list[tuple[str, str, str | None]] = []

    async def emit_log(agent, message, level="info"):
        return None

    async def emit_packet(packet):
        return None

    async def emit_status(agent, status, command_id=None, note=None):
        statuses.append((agent, status, note))

    packets = await producer._stream_intents(
        intents, "cmd-say", emit_log, emit_packet, emit_status, scene
    )
    return packets, statuses


async def test_say_used_as_active_note(producer: Producer):
    scene = scene_with("CORE_SPHERE")
    intent = Intent(
        action="transform",
        target="CORE_SPHERE",
        position=(0, 2, 0),
        say="taking the sphere up on a three-count",
    )
    _, statuses = await _collect(producer, [intent], scene)
    active_notes = [note for agent, status, note in statuses if status == "active"]
    assert active_notes == ["taking the sphere up on a three-count"]


async def test_missing_say_uses_grammar_radio(producer: Producer):
    scene = scene_with("CORE_SPHERE")
    intent = Intent(action="transform", target="CORE_SPHERE", position=(0, 2, 0))
    _, statuses = await _collect(producer, [intent], scene)
    active_notes = [note for agent, status, note in statuses if status == "active"]
    assert active_notes == ["moving CORE_SPHERE"]


async def test_say_logged_by_specialist(producer: Producer):
    scene = scene_with("CORE_SPHERE")
    logged: list[tuple[str, str]] = []

    async def emit_log(agent, message, level="info"):
        logged.append((agent, message))

    intent = Intent(
        action="transform",
        target="CORE_SPHERE",
        position=(0, 2, 0),
        say="taking the sphere up on a three-count",
    )
    await producer._build_packets_for_intent(intent, emit_log, scene=scene)
    assert ("AssetAnimator", "taking the sphere up on a three-count") in logged
