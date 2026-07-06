"""Numbered performer registry — assignments persist across takes."""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

_PERFORMERS: dict[int, "PerformerAssignment"] = {}

_MAX_RECENT = 5

# Light persona table — colors the LLM's `say` voice and motion choices when a
# numbered performer is addressed. Not user-configurable; a fixed crew flavor.
PERSONAS: dict[int, str] = {
    1: "precise, minimal",
    2: "playful, big moves",
    3: "moody, dramatic",
    4: "fast, energetic",
}

CREW_PERSONAS: dict[str, str] = {
    "AssetAnimator": "kinetic, verbs first",
    "LightingTech": "talks in stops and warmth, laconic",
    "VFXOperator": "glitchy enthusiasm, comp jargon",
    "Producer": "calm, decisive, time-aware",
}


@dataclass
class PerformerAssignment:
    target: str
    role: str | None = None
    recent: deque[str] = field(default_factory=lambda: deque(maxlen=_MAX_RECENT))


def assign(performer: int, target: str, role: str | None = None) -> None:
    """(Re)assign a performer. A fresh assignment starts with empty recent-work
    memory — a new target means "again but bigger" has nothing to be relative to
    yet."""
    _PERFORMERS[performer] = PerformerAssignment(target=target, role=role)


def get(performer: int) -> PerformerAssignment | None:
    return _PERFORMERS.get(performer)


def persona(performer: int) -> str | None:
    return PERSONAS.get(performer)


def record_action(performer: int, summary: str) -> None:
    """Remember a short action summary so a later 'again but bigger' can be
    grounded relative to this performer's own last move."""
    assignment = _PERFORMERS.get(performer)
    if assignment is not None and summary:
        assignment.recent.append(summary)


def brief() -> str:
    if not _PERFORMERS:
        return "PERFORMERS: (none assigned)"
    lines = ["PERFORMERS:"]
    for n in sorted(_PERFORMERS):
        a = _PERFORMERS[n]
        role = f" ({a.role})" if a.role else ""
        persona_str = PERSONAS.get(n)
        persona_part = f" ({persona_str})" if persona_str else ""
        recent_part = f" — recent: {'; '.join(a.recent)}" if a.recent else ""
        lines.append(f"  Agent {n} → {a.target}{role}{persona_part}{recent_part}")
    return "\n".join(lines)


def crew_brief() -> str:
    lines = ["CREW VOICES:"]
    for agent, persona in CREW_PERSONAS.items():
        lines.append(f"  {agent}: {persona}")
    lines.append(
        "Route each intent's `say` to the specialist who owns that action "
        "(transform/animate/spawn→AssetAnimator, lights/material→LightingTech, "
        "fx→VFXOperator, playback/plan→Producer)."
    )
    return "\n".join(lines)


def crew_persona(agent: str) -> str | None:
    return CREW_PERSONAS.get(agent)


def clear() -> None:
    _PERFORMERS.clear()
