"""Vision-on-command: multimodal Anthropic path and frame handling."""
import logging

import pytest

from app import llm
from app.fallback_parser import parse
from app.schema import Intent, IntentList, SceneFrame

_ENV_KEYS = ("ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "DIRECTOR_LLM_PROVIDER", "DIRECTOR_MODEL")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for key in _ENV_KEYS:
        monkeypatch.delenv(key, raising=False)


class _FakeAnthropicMessages:
    def __init__(self, parsed: IntentList | None = None) -> None:
        self.calls: list[dict] = []
        self._parsed = parsed or IntentList(intents=[])

    def parse(self, **kwargs):
        self.calls.append(kwargs)
        return type("M", (), {"parsed_output": self._parsed})()


class _FakeAnthropic:
    def __init__(self, parsed: IntentList | None = None) -> None:
        self.messages = _FakeAnthropicMessages(parsed)


class _FakeDeepSeekCompletions:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        message = type("M", (), {"content": '{"intents": []}'})()
        choice = type("C", (), {"message": message})()
        return type("R", (), {"choices": [choice]})()


class _FakeDeepSeek:
    def __init__(self) -> None:
        self.chat = type("Chat", (), {"completions": _FakeDeepSeekCompletions()})()


@pytest.fixture
def sample_frame() -> SceneFrame:
    return SceneFrame(width=640, height=360, data="aGVsbG8=", capturedAt=1.0)


async def test_anthropic_multimodal_includes_image(monkeypatch, sample_frame):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "a")
    monkeypatch.setenv("DIRECTOR_LLM_PROVIDER", "anthropic")
    fake = _FakeAnthropic()
    monkeypatch.setattr(llm, "get_anthropic_client", lambda: fake)

    await llm.parse_intents("look at the shot", None, sample_frame)

    content = fake.messages.calls[0]["messages"][0]["content"]
    assert isinstance(content, list)
    assert content[0]["type"] == "image"
    assert content[0]["source"]["data"] == "aGVsbG8="
    assert content[1]["text"] == "look at the shot"


async def test_anthropic_text_only_without_frame(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "a")
    monkeypatch.setenv("DIRECTOR_LLM_PROVIDER", "anthropic")
    fake = _FakeAnthropic()
    monkeypatch.setattr(llm, "get_anthropic_client", lambda: fake)

    await llm.parse_intents("add a red box", None, None)

    content = fake.messages.calls[0]["messages"][0]["content"]
    assert content == "add a red box"


async def test_vision_without_anthropic_key_returns_none(monkeypatch, sample_frame, caplog):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "d")
    fake = _FakeDeepSeek()
    monkeypatch.setattr(llm, "get_deepseek_client", lambda: fake)

    with caplog.at_level(logging.WARNING):
        result = await llm.parse_intents("look at the shot", None, sample_frame)

    assert result is None
    assert "ANTHROPIC_API_KEY not set" in caplog.text
    assert fake.chat.completions.calls == []


def test_fallback_look_at_shot_describe():
    intents = parse("look at the shot")
    assert len(intents) == 1
    assert intents[0].action == "describe"


def test_fallback_too_dark_warm_lights():
    intents = parse("too dark, warm it up")
    assert len(intents) == 1
    assert intents[0].action == "update_lights"
    assert intents[0].ambient_color == "#ffd9a8"


async def test_anthropic_vision_lighting_intent(monkeypatch, sample_frame):
    """Vision + relight phrasing returns update_lights from mocked LLM output."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "a")
    monkeypatch.setenv("DIRECTOR_LLM_PROVIDER", "anthropic")
    parsed = IntentList(
        intents=[
            Intent(
                action="update_lights",
                ambient_color="#ffd9a8",
                key_color="#ffb066",
            )
        ]
    )
    fake = _FakeAnthropic(parsed)
    monkeypatch.setattr(llm, "get_anthropic_client", lambda: fake)

    result = await llm.parse_intents("too dark, warm it up", None, sample_frame)

    assert result is not None
    assert result.intents[0].action == "update_lights"
