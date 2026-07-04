"""Provider selection + DeepSeek JSON-mode parse (stubbed client, no network)."""
import pytest

from app import llm
from app.agents.directors_assistant import DirectorsAssistant

_ENV_KEYS = ("ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "DIRECTOR_LLM_PROVIDER", "DIRECTOR_MODEL")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for key in _ENV_KEYS:
        monkeypatch.delenv(key, raising=False)


# --- Fake OpenAI-compatible DeepSeek client -------------------------------- #


class _FakeCompletions:
    def __init__(self, content: str) -> None:
        self._content = content
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        message = type("M", (), {"content": self._content})()
        choice = type("C", (), {"message": message})()
        return type("R", (), {"choices": [choice]})()


class _FakeDeepSeek:
    def __init__(self, content: str) -> None:
        self.chat = type("Chat", (), {"completions": _FakeCompletions(content)})()


# --- Provider selection ---------------------------------------------------- #


@pytest.mark.parametrize(
    "env,expected",
    [
        ({}, None),
        ({"ANTHROPIC_API_KEY": "a"}, "anthropic"),
        ({"DEEPSEEK_API_KEY": "d"}, "deepseek"),
        # DeepSeek wins the auto race when both keys are present.
        ({"DEEPSEEK_API_KEY": "d", "ANTHROPIC_API_KEY": "a"}, "deepseek"),
        # Explicit override beats key presence.
        ({"DIRECTOR_LLM_PROVIDER": "anthropic", "DEEPSEEK_API_KEY": "d"}, "anthropic"),
        ({"DIRECTOR_LLM_PROVIDER": "none", "DEEPSEEK_API_KEY": "d"}, None),
        ({"DIRECTOR_LLM_PROVIDER": "deepseek"}, "deepseek"),
        # Unknown override falls through to auto-selection.
        ({"DIRECTOR_LLM_PROVIDER": "bogus", "ANTHROPIC_API_KEY": "a"}, "anthropic"),
    ],
)
def test_select_provider(monkeypatch, env, expected):
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    assert llm.select_provider() == expected


def test_no_provider_short_circuits_parse():
    async def run():
        return await llm.parse_intents("add a red box", None)

    import asyncio

    assert asyncio.run(run()) is None


# --- DeepSeek JSON parse --------------------------------------------------- #


async def test_deepseek_parse_valid_json(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "d")
    content = '{"intents": [{"action": "spawn", "primitive": "box", "color": "#ff3b30"}]}'
    fake = _FakeDeepSeek(content)
    monkeypatch.setattr(llm, "get_deepseek_client", lambda: fake)

    result = await llm.parse_intents("add a red box", None)

    assert result is not None
    assert [i.action for i in result.intents] == ["spawn"]
    assert result.intents[0].primitive == "box"
    # JSON mode + the DeepSeek default model must be requested.
    (kwargs,) = fake.chat.completions.calls
    assert kwargs["model"] == "deepseek-v4-flash"
    assert kwargs["response_format"] == {"type": "json_object"}
    assert kwargs["max_tokens"] == 2048


async def test_deepseek_model_override(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "d")
    monkeypatch.setenv("DIRECTOR_MODEL", "deepseek-v4-pro")
    fake = _FakeDeepSeek('{"intents": []}')
    monkeypatch.setattr(llm, "get_deepseek_client", lambda: fake)

    await llm.parse_intents("hello", None)

    assert fake.chat.completions.calls[0]["model"] == "deepseek-v4-pro"


async def test_deepseek_invalid_json_returns_none(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "d")
    fake = _FakeDeepSeek("this is not json")
    monkeypatch.setattr(llm, "get_deepseek_client", lambda: fake)

    assert await llm.parse_intents("add a red box", None) is None


async def test_deepseek_missing_client_returns_none(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "d")
    # Simulate the openai SDK not being importable.
    monkeypatch.setattr(llm, "get_deepseek_client", lambda: None)

    assert await llm.parse_intents("add a red box", None) is None


async def test_assistant_falls_back_on_bad_deepseek(monkeypatch):
    """Invalid DeepSeek output must degrade to the deterministic rule parser."""
    monkeypatch.setenv("DEEPSEEK_API_KEY", "d")
    monkeypatch.setattr(llm, "get_deepseek_client", lambda: _FakeDeepSeek("garbage"))

    intents, source = await DirectorsAssistant().parse("add a red box", None)

    assert source == "fallback"
    assert intents and intents[0].action == "spawn"
