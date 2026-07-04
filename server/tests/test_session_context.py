"""Conversation memory: recording, pronouns, and live amendments."""
from app import session_context
from app.agents.producer import Producer
from app.fallback_parser import parse

from tests.helpers import scene_with


def test_record_captures_target_and_summary():
    intents = parse("move the box up 2", scene_with("BOX_MDL_01"))
    session_context.record("move the box up 2", intents)
    (exchange,) = session_context.history()
    assert exchange.text == "move the box up 2"
    assert exchange.targets == ["BOX_MDL_01"]
    assert session_context.last_target() == "BOX_MDL_01"


def test_last_target_scans_back_over_empty_exchanges():
    scene = scene_with("CORE_SPHERE")
    session_context.record("move the sphere up 2", parse("move the sphere up 2", scene))
    session_context.record("enable bloom", parse("enable bloom"))  # no target
    assert session_context.last_target() == "CORE_SPHERE"


def test_pronoun_resolves_to_last_target():
    scene = scene_with("CORE_SPHERE")
    session_context.record("move the sphere up 2", parse("move the sphere up 2", scene))
    (i,) = parse("move it left 1", scene)
    assert i.action == "transform"
    assert i.target == "CORE_SPHERE"
    assert i.position == (-1.0, 0.0, 0.0)


def test_amendment_go_back_a_bit_within_same_command():
    scene = scene_with("CORE_SPHERE")
    intents = parse("move the ball up 1.5 then go back a bit", scene)
    assert [i.action for i in intents] == ["transform", "transform"]
    back = intents[1]
    assert back.target == "CORE_SPHERE"
    assert back.mode == "relative"
    assert back.position == (0.0, 0.0, 0.25)  # 'a bit' -> 0.25 on +Z


def test_amendment_across_commands():
    scene = scene_with("BOX_MDL_01")
    session_context.record("move the box up 2", parse("move the box up 2", scene))
    (i,) = parse("down more")
    assert i.action == "transform"
    assert i.target == "BOX_MDL_01"
    assert i.position == (0.0, -1.0, 0.0)  # 'more' -> 1.0 on -Y


def test_bare_amendment_without_history_is_dropped():
    assert parse("go back a bit") == []


def test_again_repeats_last_transform():
    scene = scene_with("BOX_MDL_01")
    session_context.record("move the box up 2", parse("move the box up 2", scene))
    (i,) = parse("again")
    assert i.action == "transform"
    assert i.target == "BOX_MDL_01"
    assert i.position == (0.0, 2.0, 0.0)


async def test_producer_records_after_parse(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.delenv("DIRECTOR_LLM_PROVIDER", raising=False)
    producer = Producer()
    scene = scene_with("CORE_SPHERE")
    await producer.handle_user_command("move the ball up 1.5", scene)
    assert session_context.last_target() == "CORE_SPHERE"
    packets, _ = await producer.handle_user_command("go back a bit", scene)
    assert [p.command for p in packets] == ["TRANSFORM_OBJECT"]
    assert packets[0].payload.target.name == "CORE_SPHERE"
    assert packets[0].payload.mode == "relative"
