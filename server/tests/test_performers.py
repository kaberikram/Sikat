"""Numbered performer assignment and addressed direction."""
from app.agents.producer import Producer
from app.fallback_parser import parse
from app import performers, session_context

from tests.helpers import scene_with


def setup_function():
    performers.clear()
    session_context.clear()


def test_assign_agent_one_on_sphere():
    scene = scene_with("CORE_SPHERE")
    intents = parse("agent 1, you're on the sphere", scene)
    assert len(intents) == 1
    i = intents[0]
    assert i.action == "assign"
    assert i.addressee == 1
    assert i.target == "CORE_SPHERE"


def test_performer_number_words():
    scene = scene_with("CORE_SPHERE")
    (i,) = parse("performer one, you take the sphere", scene)
    assert i.action == "assign"
    assert i.addressee == 1


def test_sticky_addressee():
    scene = scene_with("CORE_SPHERE")
    parse("agent 1", scene)
    (i,) = parse("move the sphere up 2", scene)
    assert i.addressee == 1
    assert i.action == "transform"


async def test_producer_assign_no_packets(producer: Producer):
    scene = scene_with("CORE_SPHERE")
    packets, describe_only = await producer.handle_user_command(
        "agent 1, you're on the sphere", scene
    )
    assert packets == []
    assert describe_only
    assert performers.get(1) is not None
    assert performers.get(1).target == "CORE_SPHERE"


async def test_producer_addressed_direction_resolves_target(producer: Producer):
    scene = scene_with("CORE_SPHERE")
    await producer.handle_user_command("agent 1, you're on the sphere", scene)
    packets, _ = await producer.handle_user_command(
        "agent 1, go in, scale the sphere up", scene
    )
    assert len(packets) >= 1
    assert packets[0].target_agent == "Agent1"
    assert packets[0].command == "TRANSFORM_OBJECT"
