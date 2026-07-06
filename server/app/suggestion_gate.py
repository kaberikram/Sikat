"""Rate limiting and hysteresis for proactive crew suggestions."""
from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass
class GateConfig:
    kind_cooldown_sec: float = 90.0
    global_gap_sec: float = 30.0
    manual_reaction_gap_sec: float = 20.0
    dedupe_cooldown_sec: float = 90.0
    llm_bucket_capacity: int = 2
    llm_refill_per_min: float = 1.0

    @classmethod
    def from_env(cls) -> GateConfig:
        return cls(
            kind_cooldown_sec=float(os.getenv("DIRECTOR_SUGGEST_KIND_COOLDOWN", "90")),
            global_gap_sec=float(os.getenv("DIRECTOR_SUGGEST_GLOBAL_GAP", "30")),
            manual_reaction_gap_sec=float(os.getenv("DIRECTOR_SUGGEST_MANUAL_GAP", "20")),
            dedupe_cooldown_sec=float(os.getenv("DIRECTOR_SUGGEST_DEDUPE_COOLDOWN", "90")),
            llm_bucket_capacity=int(os.getenv("DIRECTOR_SUGGEST_LLM_BUCKET", "2")),
            llm_refill_per_min=float(os.getenv("DIRECTOR_SUGGEST_LLM_REFILL", "1")),
        )


class SuggestionGate:
    """Injectable clock for tests: callable returning monotonic seconds."""

    def __init__(self, clock, config: GateConfig | None = None) -> None:
        self._clock = clock
        self._config = config or GateConfig.from_env()
        self._last_global: float = -1e9
        self._last_by_kind: dict[str, float] = {}
        self._last_by_dedupe: dict[str, float] = {}
        self._last_manual: float = -1e9
        self._active_dedupes: set[str] = set()
        self._llm_tokens: float = float(self._config.llm_bucket_capacity)
        self._last_refill: float = clock()

    def update_active_dedupes(self, keys: set[str]) -> None:
        self._active_dedupes = keys

    def allow(self, kind: str, dedupe_key: str, *, is_manual: bool = False) -> bool:
        now = self._clock()
        if is_manual:
            if now - self._last_manual < self._config.manual_reaction_gap_sec:
                return False
            return True

        if now - self._last_global < self._config.global_gap_sec:
            return False

        last_kind = self._last_by_kind.get(kind)
        if last_kind is not None and now - last_kind < self._config.kind_cooldown_sec:
            return False

        last_dedupe = self._last_by_dedupe.get(dedupe_key)
        if last_dedupe is not None:
            if dedupe_key in self._active_dedupes:
                return False
            if now - last_dedupe < self._config.dedupe_cooldown_sec:
                return False

        return True

    def record(self, kind: str, dedupe_key: str, *, is_manual: bool = False, used_llm: bool = False) -> None:
        now = self._clock()
        if is_manual:
            self._last_manual = now
            return
        self._last_global = now
        self._last_by_kind[kind] = now
        self._last_by_dedupe[dedupe_key] = now
        if used_llm:
            self._refill_tokens(now)

    def try_consume_llm_token(self) -> bool:
        now = self._clock()
        self._refill_tokens(now)
        if self._llm_tokens >= 1.0:
            self._llm_tokens -= 1.0
            return True
        return False

    def _refill_tokens(self, now: float) -> None:
        elapsed_min = (now - self._last_refill) / 60.0
        if elapsed_min <= 0:
            return
        self._llm_tokens = min(
            float(self._config.llm_bucket_capacity),
            self._llm_tokens + elapsed_min * self._config.llm_refill_per_min,
        )
        self._last_refill = now
