"""Latest scene snapshot reported by the editor, used to ground agent parsing."""
from __future__ import annotations

from .schema import SceneState

_latest: SceneState | None = None


def update(state: SceneState) -> None:
    global _latest
    _latest = state


def latest() -> SceneState | None:
    return _latest


def clear() -> None:
    global _latest
    _latest = None
