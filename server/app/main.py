"""Director Mode WebSocket server.

Run from server/:  uv run uvicorn app.main:app --port 8000
"""
from __future__ import annotations

import asyncio
import logging
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from . import scene_state
from .agents.producer import Producer
from .schema import (
    MoveCameraPacket,
    MoveCameraPayload,
    SceneState,
    Telemetry,
    UserCommand,
    agent_command_message,
    agent_log_message,
    client_message_adapter,
    error_message,
)

log = logging.getLogger("director")
logging.basicConfig(level=logging.INFO)

TELEMETRY_MIN_INTERVAL = 1.0 / 20.0  # broadcast camera telemetry at <= 20 Hz


class ConnectionManager:
    def __init__(self) -> None:
        self.active: set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.active.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self.active.discard(ws)

    async def broadcast(self, payload: dict) -> None:
        for ws in list(self.active):
            try:
                await ws.send_json(payload)
            except Exception:
                self.active.discard(ws)


app = FastAPI(title="RADIO_EDIT Director Server")
manager = ConnectionManager()
producer = Producer()
_last_telemetry = 0.0


@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True, "clients": len(manager.active)}


async def _handle_user_command(msg: UserCommand) -> None:
    async def emit(agent: str, message: str, level: str = "info") -> None:
        await manager.broadcast(agent_log_message(agent, message, level, msg.commandId))

    try:
        packets = await producer.handle_user_command(
            msg.text, scene_state.latest(), msg.commandId, emit
        )
        if not packets:
            await manager.broadcast(
                error_message(f"no actionable direction in: {msg.text!r}", msg.commandId)
            )
            return
        for packet in packets:
            await manager.broadcast(agent_command_message(packet))
    except Exception as exc:  # never let one bad command kill the socket loop
        log.exception("user command failed: %s", msg.text)
        await manager.broadcast(error_message(str(exc), msg.commandId))


async def _handle_telemetry(msg: Telemetry) -> None:
    global _last_telemetry
    t = time.monotonic()
    if t - _last_telemetry < TELEMETRY_MIN_INTERVAL:
        return
    _last_telemetry = t
    # Telemetry rides the same MOVE_CAMERA path as agent commands (no
    # transition -> the client applies the pose immediately).
    packet = MoveCameraPacket(
        payload=MoveCameraPayload(
            position=msg.pose.position, rotation=msg.pose.rotation, fov=msg.pose.fov
        )
    )
    await manager.broadcast(agent_command_message(packet))


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    await manager.connect(ws)
    log.info("client connected (%d active)", len(manager.active))
    try:
        while True:
            raw = await ws.receive_json()
            try:
                msg = client_message_adapter.validate_python(raw)
            except ValidationError as exc:
                await ws.send_json(error_message(f"invalid message: {exc.error_count()} error(s)"))
                continue
            if isinstance(msg, SceneState):
                scene_state.update(msg)
            elif isinstance(msg, UserCommand):
                # LLM latency must never block the socket read loop
                asyncio.create_task(_handle_user_command(msg))
            elif isinstance(msg, Telemetry):
                await _handle_telemetry(msg)
    except WebSocketDisconnect:
        manager.disconnect(ws)
        log.info("client disconnected (%d active)", len(manager.active))
