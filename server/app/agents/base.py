"""Shared agent plumbing.

Specialists are deterministic Python: they turn already-parsed Intents into
validated CommandPackets (unit conversion, preset expansion, clamping via the
schema). Only the Director's Assistant touches the LLM, which keeps everything
below it testable without an API key.
"""
from __future__ import annotations

from typing import Any, Awaitable, Callable

# emit(agent_name, message, level)
EmitLog = Callable[[str, str, str], Awaitable[None]]
# emit_packet(command_packet)
EmitPacket = Callable[[Any], Awaitable[None]]
# emit_status(agent_name, status, command_id, note)
EmitStatus = Callable[[str, str, "str | None", "str | None"], Awaitable[None]]


async def _noop_emit(agent: str, message: str, level: str = "info") -> None:
    return None


async def _noop_packet(packet: Any) -> None:
    return None


async def _noop_status(
    agent: str, status: str, command_id: str | None = None, note: str | None = None
) -> None:
    return None
