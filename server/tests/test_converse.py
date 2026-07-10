"""Natural Director Link — converse / soft-miss / no hard error on open speech."""
from __future__ import annotations

from app.agents.producer import Producer
from app.converse import converse_intent, is_open_speech, radio_reply
from app.fallback_parser import parse
from app.llm import SYSTEM_PROMPT_TEMPLATE


def test_is_open_speech_greetings():
    assert is_open_speech("hello hello")
    assert is_open_speech("hey")
    assert is_open_speech("hi")
    assert is_open_speech("thanks")
    assert is_open_speech("thank you")
    assert is_open_speech("you there?")
    assert is_open_speech("are you there")


def test_is_open_speech_rejects_set_commands():
    assert not is_open_speech("add a red box")
    assert not is_open_speech("squash the sphere")
    assert not is_open_speech("hello add a box")
    assert not is_open_speech("move the sphere up")


def test_grammar_hello_is_describe():
    intents = parse("hello hello")
    assert len(intents) == 1
    assert intents[0].action == "describe"
    assert intents[0].describe_message
    assert intents[0].say


def test_grammar_thanks_is_describe():
    intents = parse("thanks")
    assert len(intents) == 1
    assert intents[0].action == "describe"


def test_grammar_add_box_still_spawn():
    intents = parse("add a red box")
    assert len(intents) == 1
    assert intents[0].action == "spawn"


def test_llm_prompt_converse_not_empty_for_chitchat():
    assert "Conversation / presence" in SYSTEM_PROMPT_TEMPLATE
    assert "Never empty for greetings" in SYSTEM_PROMPT_TEMPLATE
    assert "true noise" in SYSTEM_PROMPT_TEMPLATE.lower() or "Empty result" in SYSTEM_PROMPT_TEMPLATE


async def test_direct_hello_describe_only_no_error(producer: Producer, scene):
    logs: list[tuple[str, str]] = []
    statuses: list[tuple[str, str, str | None]] = []

    async def emit_log(agent: str, message: str, level: str = "info") -> None:
        logs.append((agent, message))

    async def emit_status(
        agent: str, status: str, command_id: str | None = None, note: str | None = None
    ) -> None:
        statuses.append((agent, status, note))

    packets, describe_only = await producer.direct(
        "hello hello",
        scene,
        command_id="cmd-hello",
        emit_log=emit_log,
        emit_status=emit_status,
    )
    assert packets == []
    assert describe_only is True
    assert any("hello" in msg.lower() or "standing" in msg.lower() or "copy" in msg.lower()
               or "ears" in msg.lower() or "right here" in msg.lower() or "yep" in msg.lower()
               or "director" in msg.lower() for _, msg in logs)


async def test_direct_thanks_describe_only(producer: Producer, scene):
    logs: list[str] = []

    async def emit_log(agent: str, message: str, level: str = "info") -> None:
        logs.append(message)

    packets, describe_only = await producer.direct(
        "thanks", scene, emit_log=emit_log
    )
    assert packets == []
    assert describe_only is True
    assert logs


async def test_direct_you_there_describe_only(producer: Producer, scene):
    packets, describe_only = await producer.direct("you there?", scene)
    assert packets == []
    assert describe_only is True


async def test_direct_add_box_still_packets(producer: Producer, scene):
    packets, describe_only = await producer.direct("add a red box", scene)
    assert describe_only is False
    assert any(p.command == "SPAWN_OBJECT" for p in packets)


async def test_direct_squash_still_animate_or_transform(producer: Producer, scene):
    packets, describe_only = await producer.direct("squash the sphere", scene)
    assert describe_only is False
    assert packets
    assert packets[0].command in (
        "TRANSFORM_OBJECT",
        "SET_KEYFRAMES",
        "SET_MATERIAL",
        "ANIMATE_OBJECT",
    )


async def test_soft_miss_joke_describe_only(producer: Producer, scene):
    logs: list[str] = []

    async def emit_log(agent: str, message: str, level: str = "info") -> None:
        logs.append(message)

    packets, describe_only = await producer.direct(
        "tell me a joke", scene, emit_log=emit_log
    )
    assert packets == []
    assert describe_only is True
    assert logs


async def test_hearing_you_on_pure_defer(producer: Producer, scene, monkeypatch):
    """When LLM is available and clause is LLM-owned, emit hearing-you before stream."""
    statuses: list[tuple[str, str | None]] = []

    async def emit_status(
        agent: str, status: str, command_id: str | None = None, note: str | None = None
    ) -> None:
        statuses.append((status, note))

    async def fake_stream(*_a, **_k):
        if False:  # pragma: no cover
            yield None

    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr("app.agents.producer.llm.stream_intents", fake_stream)
    monkeypatch.setattr("app.agents.producer.llm.select_provider", lambda _frame=None: "deepseek")

    packets, describe_only = await producer.direct(
        "xyzzy plugh frobozz",
        scene,
        command_id="cmd-defer",
        emit_status=emit_status,
    )
    assert any(note == "hearing you" for _, note in statuses)
    # Empty LLM + no grammar rescue → soft miss radio
    assert packets == []
    assert describe_only is True


def test_radio_reply_and_converse_intent():
    intent = converse_intent("hello")
    assert intent.action == "describe"
    assert intent.describe_message == intent.say
    assert radio_reply("asdfghjkl noise")  # soft-miss pool
