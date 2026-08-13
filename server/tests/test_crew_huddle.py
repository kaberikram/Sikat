"""Observer huddle: live suggestion or silence — never template-pool copy."""
from __future__ import annotations

from app.crew_huddle import phrase_observation
from app.observer import emit_suggestion_from_producer
from app.suggestion_gate import GateConfig, SuggestionGate
from tests.test_observer import FakeClock, _obs


async def test_phrase_observation_silent_without_provider(monkeypatch):
    monkeypatch.setattr("app.crew_huddle.llm.select_provider", lambda: None)
    phrased = await phrase_observation(_obs(), None)
    assert phrased["say"] is None
    assert phrased["suggested_command"] is None


async def test_phrase_observation_silent_on_llm_failure(monkeypatch):
    async def boom(*_args, **_kwargs):
        raise RuntimeError("planner down")

    monkeypatch.setattr("app.crew_huddle.llm.select_provider", lambda: "deepseek")
    monkeypatch.setattr("app.crew_huddle.llm.parse_intents", boom)
    phrased = await phrase_observation(_obs(), None)
    assert phrased["say"] is None
    assert "BOX off stage" not in str(phrased)


async def test_producer_suggestion_silent_without_llm_token():
    class FakeWs:
        def __init__(self) -> None:
            self.sent: list[dict] = []

        async def send_json(self, msg: dict) -> None:
            self.sent.append(msg)

    clock = FakeClock()
    gate = SuggestionGate(clock, GateConfig(llm_bucket_capacity=0, global_gap_sec=0, kind_cooldown_sec=0))
    ws = FakeWs()
    emitted = await emit_suggestion_from_producer(ws, _obs(), gate=gate)
    assert emitted is False
    assert ws.sent == []
