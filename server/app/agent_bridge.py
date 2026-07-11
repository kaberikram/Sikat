"""Request/response bridge for the SceneAgent loop.

The agent runs server-side but its tools execute in the browser: each call
sends an agent_tool_use message to the owning websocket and awaits the
matching agent_tool_result (correlated by requestId). One bridge per
connection; on disconnect all pending calls fail fast so the loop can wind
down instead of hanging until timeout.
"""
from __future__ import annotations

import asyncio
import uuid

from fastapi import WebSocket

from .schema import AgentToolName, AgentToolResult, agent_tool_use_message

DEFAULT_TOOL_TIMEOUT_SEC = 20.0


class BridgeClosed(Exception):
    """The client disconnected while tool calls were pending."""


class AgentBridge:
    def __init__(self, ws: WebSocket) -> None:
        self._ws = ws
        self._pending: dict[str, asyncio.Future[AgentToolResult]] = {}
        self._closed = False

    async def call(
        self,
        tool: AgentToolName,
        payload: dict,
        command_id: str,
        timeout: float = DEFAULT_TOOL_TIMEOUT_SEC,
    ) -> AgentToolResult:
        if self._closed:
            raise BridgeClosed("client disconnected")
        request_id = uuid.uuid4().hex
        future: asyncio.Future[AgentToolResult] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            await self._ws.send_json(
                agent_tool_use_message(command_id, request_id, tool, payload)
            )
            return await asyncio.wait_for(future, timeout)
        finally:
            self._pending.pop(request_id, None)

    def resolve(self, msg: AgentToolResult) -> None:
        """Called from the websocket read loop when a tool result arrives."""
        future = self._pending.get(msg.requestId)
        if future is not None and not future.done():
            future.set_result(msg)

    def close(self) -> None:
        self._closed = True
        for future in self._pending.values():
            if not future.done():
                future.set_exception(BridgeClosed("client disconnected"))
        self._pending.clear()
