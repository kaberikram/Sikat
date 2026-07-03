"""Shared agent plumbing.

Specialists are deterministic Python: they turn already-parsed Intents into
validated CommandPackets (unit conversion, preset expansion, clamping via the
schema). Only the Director's Assistant touches the LLM, which keeps everything
below it testable without an API key.
"""
from __future__ import annotations

from typing import Awaitable, Callable

# emit(agent_name, message, level)
EmitLog = Callable[[str, str, str], Awaitable[None]]


async def _noop_emit(agent: str, message: str, level: str = "info") -> None:
    return None
