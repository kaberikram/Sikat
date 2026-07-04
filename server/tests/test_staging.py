"""Staged execution: Producer.direct streams presence + packets over time."""
import pytest

from app.agents.producer import Producer
from app.schema import CameraSnapshot, ObjectSnapshot, SceneState


@pytest.fixture
def scene() -> SceneState:
    return SceneState(
        objects=[
            ObjectSnapshot(id="a1", name="CORE_SPHERE"),
            ObjectSnapshot(id="b2", name="BOX_MDL_01"),
        ],
        camera=CameraSnapshot(fov=50),
    )


@pytest.fixture
def producer(monkeypatch) -> Producer:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    return Producer()


async def _collect(producer, text, scene):
    packets: list = []
    statuses: list[tuple[str, str]] = []

    async def emit_log(agent, message, level="info"):
        return None

    async def emit_packet(packet):
        packets.append(packet)

    async def emit_status(agent, status, command_id=None, note=None):
        statuses.append((agent, status))

    result = await producer.direct(
        text, scene, "cmd-1", emit_log, emit_packet, emit_status
    )
    return result, packets, statuses


async def test_direct_emits_active_and_idle_per_agent(producer, scene):
    result, packets, statuses = await _collect(
        producer, "add a red box then dim the lights", scene
    )
    # Two specialists are involved: AssetAnimator (spawn) and LightingTech (lights).
    agents = {agent for agent, _ in statuses}
    assert agents == {"AssetAnimator", "LightingTech"}
    # Each announces active exactly once and stands down idle exactly once.
    for agent in agents:
        assert statuses.count((agent, "active")) == 1
        assert statuses.count((agent, "idle")) == 1


async def test_direct_streams_every_planned_packet(producer, scene):
    result, packets, _ = await _collect(
        producer, "add a red box then dim the lights", scene
    )
    # The staged stream carries exactly the planned packets, all tagged.
    assert [p.command for p in packets] == [p.command for p in result]
    assert {p.command for p in packets} == {"SPAWN_OBJECT", "UPDATE_LIGHTS"}
    assert all(p.commandId == "cmd-1" for p in packets)


async def test_direct_active_precedes_packet_for_agent(producer, scene):
    _, packets, statuses = await _collect(producer, "add a red box", scene)
    # A cursor must be announced active before its packet is applied.
    first_active = next(i for i, (_, s) in enumerate(statuses) if s == "active")
    assert statuses[first_active][0] == "AssetAnimator"
    assert statuses[-1] == ("AssetAnimator", "idle")


async def test_direct_no_actionable_command_streams_nothing(producer, scene):
    result, packets, statuses = await _collect(producer, "tell me a joke", scene)
    assert result == []
    assert packets == []
    assert statuses == []
