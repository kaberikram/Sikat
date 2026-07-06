"""Barge-in: command_cancel on supersede and freeze."""
from __future__ import annotations

from app import active_commands
from app.agents.producer import Producer


async def _collect_with_cancel(producer: Producer, commands: list[tuple[str, str]], scene):
    packets: list = []
    cancels: list[dict] = []

    async def emit_log(agent, message, level="info"):
        return None

    async def emit_packet(packet):
        packets.append(packet)

    async def emit_status(agent, status, command_id=None, note=None):
        return None

    async def emit_cancel(payload: dict):
        cancels.append(payload)

    for text, command_id in commands:
        await producer.direct(
            text, scene, command_id, emit_log, emit_packet, emit_status, emit_cancel=emit_cancel
        )
    return packets, cancels


async def test_supersede_emits_cancel(producer, scene):
    packets, cancels = await _collect_with_cancel(
        producer,
        [
            ("move the box up 2", "cmd-1"),
            ("move the box up 3", "cmd-2"),
        ],
        scene,
    )
    assert len(packets) == 2
    assert len(cancels) == 1
    assert cancels[0]["type"] == "command_cancel"
    assert cancels[0]["commandId"] == "cmd-1"
    assert cancels[0]["supersededBy"] == "cmd-2"
    assert cancels[0]["reason"] == "supersede"


async def test_freeze_emits_stop_cancel(producer, scene):
    from app import session_context
    from app.schema import Intent
    from tests.helpers import scene_with

    playing = scene_with("CORE_SPHERE")
    playing.isPlaying = True
    obj = playing.objects[0]
    obj.keyframedProperties = ["position"]
    obj.tracks = [{"property": "position", "keyframeCount": 3}]

    session_context.record(
        "bounce the sphere",
        [Intent(action="animate", target="CORE_SPHERE", motion="bounce")],
    )

    packets: list = []
    cancels: list = []

    async def emit_packet(packet):
        packets.append(packet)

    async def emit_cancel(payload: dict):
        cancels.append(payload)

    active_commands.note_active("CORE_SPHERE", "ANIMATE_OBJECT", "anim-1")

    await producer.direct(
        "stop",
        playing,
        "cmd-stop",
        emit_packet=emit_packet,
        emit_cancel=emit_cancel,
    )

    assert any(p.command == "PLAYBACK" for p in packets)
    assert len(cancels) == 1
    assert cancels[0]["reason"] == "stop"
    assert cancels[0]["commandId"] == "anim-1"
