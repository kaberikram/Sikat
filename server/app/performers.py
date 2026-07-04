"""Numbered performer registry — assignments persist across takes."""
from __future__ import annotations

from dataclasses import dataclass

_PERFORMERS: dict[int, "PerformerAssignment"] = {}


@dataclass
class PerformerAssignment:
    target: str
    role: str | None = None


def assign(performer: int, target: str, role: str | None = None) -> None:
    _PERFORMERS[performer] = PerformerAssignment(target=target, role=role)


def get(performer: int) -> PerformerAssignment | None:
    return _PERFORMERS.get(performer)


def brief() -> str:
    if not _PERFORMERS:
        return "PERFORMERS: (none assigned)"
    lines = ["PERFORMERS:"]
    for n in sorted(_PERFORMERS):
        a = _PERFORMERS[n]
        role = f" ({a.role})" if a.role else ""
        lines.append(f"  Agent {n} → {a.target}{role}")
    return "\n".join(lines)


def clear() -> None:
    _PERFORMERS.clear()
