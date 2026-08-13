"""Focused tests for the DirectorPlan streaming primitives."""
from app import llm
from app.schema import PlanStep

_PLAN_WITH_FLAG = (
    '{"say":"on it","mode":"execute","needs_deeper_creativity":true,'
    '"steps":[{"action":"spawn","primitive":"box","color":"#ff3b30","say":"box in"}]}'
)


class _FakeTextStream:
    def __init__(self, text: str) -> None:
        self._text = text
        self._done = False

    def __aiter__(self):
        return self

    async def __anext__(self) -> str:
        if self._done:
            raise StopAsyncIteration
        self._done = True
        return self._text


class _FakeMessageStream:
    def __init__(self, text: str) -> None:
        self.text_stream = _FakeTextStream(text)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc) -> bool:
        return False

    async def get_final_message(self):
        return type("Message", (), {"stop_reason": "end_turn"})()


class _FakeMessages:
    def __init__(self, text: str) -> None:
        self._text = text
        self.last_kwargs: dict | None = None

    def stream(self, **kwargs):
        self.last_kwargs = kwargs
        return _FakeMessageStream(self._text)


class _FakeAnthropic:
    def __init__(self, text: str) -> None:
        self.messages = _FakeMessages(text)


def _patch_anthropic(monkeypatch, client: _FakeAnthropic) -> None:
    monkeypatch.setattr(
        llm,
        "select_tier",
        lambda frame=None, *, escalated=False: ("anthropic", "claude-opus-5"),
    )
    monkeypatch.setattr(llm, "get_async_anthropic_client", lambda: client)


def test_extract_steps_ignores_arrays_before_steps():
    buffer = (
        '{"example":[{"ignore":true}],"steps":['
        '{"action":"animate","target":"BALL","track_property":"position",'
        '"track_keyframes":[{"time":0,"value":[0,0,0]}]}]}'
    )
    slices, consumed = llm.extract_complete_array_items(buffer, 0)
    assert len(slices) == 1
    assert PlanStep.model_validate_json(slices[0]).target == "BALL"
    assert llm.extract_complete_array_items(buffer, consumed)[0] == []


def test_extract_steps_waits_for_closed_object():
    slices, consumed = llm.extract_complete_array_items(
        '{"steps":[{"action":"spawn","primitive":"box"', 0
    )
    assert slices == []
    assert consumed == 0


def test_abort_escalation_is_fast_tier_only():
    assert llm.should_abort_plan_for_escalation("fast", True)
    assert not llm.should_abort_plan_for_escalation("strong", True)
    assert not llm.should_abort_plan_for_escalation("fast", False)
    assert not llm.should_abort_plan_for_escalation("strong", False)


def test_anthropic_json_stream_disables_thinking():
    kwargs = llm._anthropic_json_stream_kwargs(max_tokens=8192)
    assert kwargs["thinking"] == {"type": "disabled"}
    assert kwargs["output_config"] == {"effort": "high"}
    assert kwargs["max_tokens"] == 8192


async def test_strong_tier_keeps_steps_when_needs_deeper_creativity(monkeypatch):
    client = _FakeAnthropic(_PLAN_WITH_FLAG)
    _patch_anthropic(monkeypatch, client)

    events = [event async for event in llm.stream_plan("surprise me", None, tier="strong")]
    steps = [event for event in events if isinstance(event, llm.Step)]
    assert len(steps) == 1
    assert steps[0].step.action == "spawn"
    assert client.messages.last_kwargs is not None
    assert client.messages.last_kwargs["max_tokens"] == 8192
    assert client.messages.last_kwargs["thinking"] == {"type": "disabled"}
    assert client.messages.last_kwargs["output_config"] == {"effort": "high"}


async def test_fast_tier_aborts_on_needs_deeper_creativity(monkeypatch):
    client = _FakeAnthropic(_PLAN_WITH_FLAG)
    _patch_anthropic(monkeypatch, client)

    events = [event async for event in llm.stream_plan("surprise me", None, tier="fast")]
    assert any(
        isinstance(event, llm.Meta) and event.needs_deeper_creativity for event in events
    )
    assert not any(isinstance(event, llm.Step) for event in events)
    assert client.messages.last_kwargs is not None
    assert client.messages.last_kwargs["max_tokens"] == 3000
    assert client.messages.last_kwargs["thinking"] == {"type": "disabled"}
