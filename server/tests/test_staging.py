"""Staged execution: Producer.direct streams presence + packets over time."""
from app.agents.producer import Producer


async def _collect(producer: Producer, text: str, scene):
    packets: list = []
    statuses: list[tuple[str, str]] = []

    async def emit_log(agent, message, level="info"):
        return None

    async def emit_packet(packet):
        packets.append(packet)

    async def emit_status(agent, status, command_id=None, note=None):
        statuses.append((agent, status))

    planned, describe_only = await producer.direct(
        text, scene, "cmd-1", emit_log, emit_packet, emit_status
    )
    return planned, describe_only, packets, statuses


async def test_direct_emits_active_and_idle_per_agent(producer, scene):
    planned, _, packets, statuses = await _collect(
        producer, "add a red box then dim the lights", scene
    )
    agents = {agent for agent, _ in statuses}
    assert agents == {"AssetAnimator", "LightingTech"}
    for agent in agents:
        assert statuses.count((agent, "active")) == 1
        assert statuses.count((agent, "idle")) == 1


async def test_direct_streams_every_planned_packet(producer, scene):
    planned, _, packets, _ = await _collect(
        producer, "add a red box then dim the lights", scene
    )
    assert [p.command for p in packets] == [p.command for p in planned]
    assert {p.command for p in packets} == {"SPAWN_OBJECT", "UPDATE_LIGHTS"}
    assert all(p.commandId == "cmd-1" for p in packets)


async def test_direct_active_precedes_packet_for_agent(producer, scene):
    _, _, packets, statuses = await _collect(producer, "add a red box", scene)
    first_active = next(i for i, (_, s) in enumerate(statuses) if s == "active")
    assert statuses[first_active][0] == "AssetAnimator"
    assert statuses[-1] == ("AssetAnimator", "idle")


async def test_direct_no_actionable_command_streams_nothing(producer, scene):
    planned, describe_only, packets, statuses = await _collect(
        producer, "tell me a joke", scene
    )
    assert planned == []
    assert describe_only is False
    assert packets == []
    assert statuses == []


def test_agent_staging_timings_are_calm():
    """Fast but alive: specialists still fan out and packets still stage,
    but the beats are short enough that commands feel immediate."""
    from app.agents.producer import AGENT_STAGGER, AGENT_STEP_DELAY

    assert 0.05 <= AGENT_STAGGER <= 0.3
    assert 0.05 <= AGENT_STEP_DELAY <= 0.35
