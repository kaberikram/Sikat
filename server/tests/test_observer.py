"""SuggestionGate unit tests."""
from __future__ import annotations

from app.heuristics import Observation
from app.suggestion_gate import GateConfig, SuggestionGate


class FakeClock:
    def __init__(self, start: float = 0.0) -> None:
        self.t = start

    def __call__(self) -> float:
        return self.t

    def advance(self, sec: float) -> None:
        self.t += sec


def _obs(kind: str = "off_stage", dedupe: str = "off_stage:box") -> Observation:
    return Observation(
        kind=kind,
        agent="AssetAnimator",
        subject_object="BOX",
        severity=4,
        template_line="BOX off stage",
        suggested_command="move BOX to center",
        dedupe_key=dedupe,
    )


def test_kind_cooldown():
    clock = FakeClock()
    cfg = GateConfig(kind_cooldown_sec=90, global_gap_sec=0, dedupe_cooldown_sec=0)
    gate = SuggestionGate(clock, cfg)
    assert gate.allow("off_stage", "k1")
    gate.record("off_stage", "k1")
    assert not gate.allow("off_stage", "k2")
    clock.advance(91)
    assert gate.allow("off_stage", "k2")


def test_global_gap():
    clock = FakeClock()
    cfg = GateConfig(global_gap_sec=30, kind_cooldown_sec=0, dedupe_cooldown_sec=0)
    gate = SuggestionGate(clock, cfg)
    assert gate.allow("a", "k1")
    gate.record("a", "k1")
    assert not gate.allow("b", "k2")
    clock.advance(31)
    assert gate.allow("b", "k2")


def test_hysteresis_blocks_while_active():
    clock = FakeClock()
    cfg = GateConfig(global_gap_sec=0, kind_cooldown_sec=0, dedupe_cooldown_sec=90)
    gate = SuggestionGate(clock, cfg)
    gate.update_active_dedupes({"off_stage:box"})
    gate.record("off_stage", "off_stage:box")
    assert not gate.allow("off_stage", "off_stage:box")
    gate.update_active_dedupes(set())
    assert not gate.allow("off_stage", "off_stage:box")
    clock.advance(91)
    assert gate.allow("off_stage", "off_stage:box")


def test_manual_reaction_gap():
    clock = FakeClock()
    cfg = GateConfig(manual_reaction_gap_sec=20, global_gap_sec=0, kind_cooldown_sec=0)
    gate = SuggestionGate(clock, cfg)
    assert gate.allow("manual_edit", "m1", is_manual=True)
    gate.record("manual_edit", "m1", is_manual=True)
    assert not gate.allow("manual_edit", "m2", is_manual=True)
    clock.advance(21)
    assert gate.allow("manual_edit", "m2", is_manual=True)


def test_llm_token_bucket():
    clock = FakeClock()
    cfg = GateConfig(llm_bucket_capacity=2, llm_refill_per_min=1)
    gate = SuggestionGate(clock, cfg)
    assert gate.try_consume_llm_token()
    assert gate.try_consume_llm_token()
    assert not gate.try_consume_llm_token()
    clock.advance(60)
    assert gate.try_consume_llm_token()
