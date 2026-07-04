"""Describe intent: log-only responses with zero command packets."""
from app.agents.producer import Producer
from app.fallback_parser import parse
from app.schema import ObjectSnapshot, SceneState

from tests.helpers import animated_sphere_scene, scene_with


def test_fallback_describe_whats_happening():
    intents = parse("what's happening", scene_with("CORE_SPHERE"))
    assert len(intents) == 1
    assert intents[0].action == "describe"
    assert intents[0].describe_topic == "scene"
    assert intents[0].describe_message


def test_fallback_describe_bounce_on_sphere():
    scene = animated_sphere_scene()
    intents = parse("how's the bounce on the sphere", scene)
    assert len(intents) == 1
    i = intents[0]
    assert i.action == "describe"
    assert i.describe_topic == "animation"
    assert i.target == "CORE_SPHERE"
    assert "Y=1.2" in (i.describe_message or "")


def test_fallback_move_still_transform():
    scene = scene_with("CORE_SPHERE")
    intents = parse("move the sphere up 2", scene)
    assert len(intents) == 1
    assert intents[0].action == "transform"


async def test_producer_describe_only_emits_no_packets(producer: Producer):
    scene = animated_sphere_scene()
    logs: list[tuple[str, str]] = []

    async def emit(agent: str, message: str, level: str = "info") -> None:
        logs.append((agent, message))

    packets, describe_only = await producer.handle_user_command(
        "how's the bounce on the sphere", scene, emit=emit
    )
    assert packets == []
    assert describe_only is True
    assert any("Y=1.2" in msg for _, msg in logs)


async def test_producer_move_sphere_still_emits_packet(producer: Producer):
    scene = scene_with("CORE_SPHERE")
    packets, describe_only = await producer.handle_user_command(
        "move the sphere up 2", scene
    )
    assert describe_only is False
    assert len(packets) == 1
    assert packets[0].command == "TRANSFORM_OBJECT"


async def test_user_command_scene_overrides_stale_latest(producer: Producer):
    """Embedded full snapshot on user_command takes precedence over heartbeat cache."""
    from app import scene_state

    stale = scene_with("OLD_OBJECT")
    scene_state.update(stale)

    fresh = SceneState(
        objects=[ObjectSnapshot(id="n1", name="NEW_BOX")],
        mode="full",
    )

    packets, _ = await producer.handle_user_command("delete the box", fresh)
    assert len(packets) == 1
    assert packets[0].payload.target.name == "NEW_BOX"
