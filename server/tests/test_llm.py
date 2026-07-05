"""Provider selection + DeepSeek JSON-mode parse (stubbed client, no network)."""
import pytest

from app import llm
from app.agents.directors_assistant import DirectorsAssistant
from app.schema import SceneFrame

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
        # Quality tier: Anthropic for text when both keys are present.
        ({"DEEPSEEK_API_KEY": "d", "ANTHROPIC_API_KEY": "a"}, "anthropic"),
        # Explicit override beats key presence (text-only).
        ({"DIRECTOR_LLM_PROVIDER": "anthropic", "DEEPSEEK_API_KEY": "d"}, "anthropic"),
        ({"DIRECTOR_LLM_PROVIDER": "none", "DEEPSEEK_API_KEY": "d"}, None),
        ({"DIRECTOR_LLM_PROVIDER": "deepseek"}, "deepseek"),
        # Unknown override falls through to auto-selection.
        ({"DIRECTOR_LLM_PROVIDER": "bogus", "ANTHROPIC_API_KEY": "a"}, "anthropic"),
    ],
)
def test_select_provider_text_only(monkeypatch, env, expected):
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    assert llm.select_provider(None) == expected


def test_select_provider_vision_routes_anthropic_when_both_keys(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "d")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "a")
    frame = SceneFrame(width=64, height=64, data="abc=", capturedAt=1.0)
    assert llm.select_provider(frame) == "anthropic"


def test_select_provider_vision_without_anthropic_key_returns_none(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "d")
    frame = SceneFrame(width=64, height=64, data="abc=", capturedAt=1.0)
    assert llm.select_provider(frame) is None


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


# --- extract_complete_intents (Phase 3 incremental JSON extractor) -------- #


def test_extract_complete_intents_single_object():
    buffer = '{"intents": [{"action": "spawn", "primitive": "box"}]}'
    slices, consumed = llm.extract_complete_intents(buffer, 0)
    assert slices == ['{"action": "spawn", "primitive": "box"}']
    assert consumed == buffer.index("}]") + 1


def test_extract_complete_intents_partial_chunk_yields_nothing():
    buffer = '{"intents": [{"action": "spawn", "prim'
    slices, consumed = llm.extract_complete_intents(buffer, 0)
    assert slices == []
    assert consumed == 0


def test_extract_complete_intents_incremental_across_chunks():
    full = (
        '{"intents": ['
        '{"action": "spawn", "primitive": "box"},'
        '{"action": "update_fx", "section": "bloom", "fx_enabled": true}'
        "]}"
    )
    consumed = 0
    collected: list[str] = []
    # Feed the buffer in small increments to simulate token-by-token streaming.
    for end in range(1, len(full) + 1):
        buffer = full[:end]
        slices, consumed = llm.extract_complete_intents(buffer, consumed)
        collected.extend(slices)
    assert len(collected) == 2
    assert '"action": "spawn"' in collected[0]
    assert '"action": "update_fx"' in collected[1]


def test_extract_complete_intents_ignores_braces_in_strings():
    buffer = '{"intents": [{"action": "describe", "describe_message": "a {weird} brace"}]}'
    slices, consumed = llm.extract_complete_intents(buffer, 0)
    assert len(slices) == 1
    intent = llm.Intent.model_validate_json(slices[0])
    assert intent.describe_message == "a {weird} brace"


def test_extract_complete_intents_handles_escaped_quotes():
    buffer = r'{"intents": [{"action": "describe", "describe_message": "she said \"hi\""}]}'
    slices, consumed = llm.extract_complete_intents(buffer, 0)
    assert len(slices) == 1
    intent = llm.Intent.model_validate_json(slices[0])
    assert intent.describe_message == 'she said "hi"'


def test_extract_complete_intents_nested_track_keyframes():
    buffer = (
        '{"intents": [{"action": "animate", "target": "SPHERE", '
        '"track_property": "position", "track_keyframes": '
        '[{"time": 0, "value": [0,0,0]}, {"time": 1, "value": [1,1,1]}]}]}'
    )
    slices, consumed = llm.extract_complete_intents(buffer, 0)
    assert len(slices) == 1
    intent = llm.Intent.model_validate_json(slices[0])
    assert intent.action == "animate"
    assert len(intent.track_keyframes) == 2


def test_extract_complete_intents_respects_consumed_offset():
    buffer = '{"intents": [{"action": "spawn", "primitive": "box"}]}'
    first_slices, consumed = llm.extract_complete_intents(buffer, 0)
    assert len(first_slices) == 1
    # Calling again with the returned consumed offset must not re-emit it.
    second_slices, consumed2 = llm.extract_complete_intents(buffer, consumed)
    assert second_slices == []
    assert consumed2 == consumed


async def test_stream_intents_no_provider_yields_nothing():
    results = [i async for i in llm.stream_intents("add a red box", None)]
    assert results == []


async def test_stream_intents_skips_invalid_slice_and_continues(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "a")

    class _FakeStreamCtx:
        def __init__(self, chunks):
            self._chunks = chunks

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        @property
        def text_stream(self):
            async def gen():
                for c in self._chunks:
                    yield c

            return gen()

    class _FakeMessages:
        def __init__(self, chunks):
            self._chunks = chunks

        def stream(self, **kwargs):
            return _FakeStreamCtx(self._chunks)

    class _FakeAsyncAnthropic:
        def __init__(self, chunks):
            self.messages = _FakeMessages(chunks)

    # Second array element is malformed (missing required action-adjacent
    # structure isn't actually invalid for Intent since all fields are
    # optional except `action`; use a truly bad payload instead).
    chunks = [
        '{"intents": [',
        '{"action": "spawn", "primitive": "box"}',
        ",",
        '{"action": "bogus_action_value"}',
        "]}",
    ]
    monkeypatch.setattr(llm, "get_async_anthropic_client", lambda: _FakeAsyncAnthropic(chunks))

    results = [i async for i in llm.stream_intents("add stuff", None)]
    # The first (valid) intent streams through; the second fails schema
    # validation (bad action literal) and is skipped, not fatal to the stream.
    assert len(results) == 1
    assert results[0].action == "spawn"
