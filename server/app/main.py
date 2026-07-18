"""Director Mode WebSocket server.

Run from server/:  uv run uvicorn app.main:app --port 8000

Loads optional secrets from server/.env (gitignored). Copy .env.example to .env.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path

from dotenv import load_dotenv

# server/.env — never committed (.gitignore). .env.example is the template.
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from . import scene_state
from . import session_context
from .agent_bridge import AgentBridge
from .agents.producer import Producer
from .converse import radio_reply
from .intent_preview import build_intent_preview
from .schema import (
    AgentAbort,
    AgentToolResult,
    MoveCameraPacket,
    MoveCameraPayload,
    SceneState,
    Telemetry,
    UserCommand,
    agent_command_message,
    agent_log_message,
    agent_status_message,
    client_message_adapter,
    error_message,
)
from .observer import run_observer
from .session_context import SessionContext, bind_session, reset_session

log = logging.getLogger("director")
logging.basicConfig(level=logging.INFO)

TELEMETRY_MIN_INTERVAL = 1.0 / 20.0  # broadcast camera telemetry at <= 20 Hz


class ConnectionManager:
    def __init__(self) -> None:
        self.active: set[WebSocket] = set()
        self.sessions: dict[WebSocket, SessionContext] = {}
        self.observers: dict[WebSocket, asyncio.Task] = {}
        self.bridges: dict[WebSocket, AgentBridge] = {}

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.active.add(ws)
        session = SessionContext()
        self.sessions[ws] = session
        self.observers[ws] = asyncio.create_task(run_observer(session, ws))
        self.bridges[ws] = AgentBridge(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self.active.discard(ws)
        self.sessions.pop(ws, None)
        task = self.observers.pop(ws, None)
        if task is not None:
            task.cancel()
        bridge = self.bridges.pop(ws, None)
        if bridge is not None:
            bridge.close()

    async def broadcast(self, payload: dict) -> None:
        for ws in list(self.active):
            try:
                await ws.send_json(payload)
            except Exception:
                self.active.discard(ws)

    async def send(self, ws: WebSocket, payload: dict) -> None:
        """Per-connection send — command output belongs to the socket that
        issued the command, not to every connected client."""
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


async def _handle_user_command(msg: UserCommand, ws: WebSocket) -> None:
    session = manager.sessions.get(ws, SessionContext())
    token = bind_session(session)
    session.command_started()
    session.cancel_active_plan()
    received_at = time.monotonic()
    first_packet_logged = False

    scene = msg.scene or session.latest_scene or scene_state.latest()
    if msg.commandId:
        preview = build_intent_preview(msg.text, scene, msg.commandId)
        if preview:
            preview["timestamp"] = time.time()
            await manager.send(ws, preview)
            log.info(
                "command %s: intent preview in %.0fms (%s)",
                msg.commandId,
                (time.monotonic() - received_at) * 1000,
                preview.get("agent"),
            )

    async def emit_log(agent: str, message: str, level: str = "info") -> None:
        await manager.send(ws, agent_log_message(agent, message, level, msg.commandId))

    async def emit_packet(packet) -> None:
        nonlocal first_packet_logged
        if not first_packet_logged:
            first_packet_logged = True
            elapsed = time.monotonic() - received_at
            log.info("command %s: first packet in %.2fs (via %s)", msg.commandId, elapsed, packet.target_agent)
        await manager.send(ws, agent_command_message(packet))
        session.note_server_edit(packet)

    async def emit_status(
        agent: str, status: str, command_id: str | None = None, note: str | None = None
    ) -> None:
        if note:
            session.note_say(note)
        await manager.send(ws, agent_status_message(agent, status, command_id, note))

    async def emit_preview(payload: dict) -> None:
        await manager.send(ws, payload)

    async def emit_plan_update(payload: dict) -> None:
        await manager.send(ws, payload)

    async def emit_cancel(payload: dict) -> None:
        await manager.send(ws, payload)

    async def emit_question(payload: dict) -> None:
        await manager.send(ws, payload)

    async def emit_suggest(obs) -> None:
        from .observer import emit_suggestion_from_producer

        await emit_suggestion_from_producer(
            ws,
            obs,
            kind="suggestion",
            scene=session.latest_scene,
            gate=session.suggestion_gate,
        )

    try:
        packets, describe_only = await producer.direct(
            msg.text,
            scene,
            msg.commandId,
            emit_log,
            emit_packet,
            emit_status,
            frame=msg.frame,
            emit_preview=emit_preview,
            emit_cancel=emit_cancel,
            emit_question=emit_question,
            emit_suggest=emit_suggest,
            emit_plan_update=emit_plan_update,
            bridge=manager.bridges.get(ws),
        )
        if not packets and not describe_only:
            # Soft miss: crew redirect, not a hard error (open speech / miss).
            await manager.send(
                ws,
                agent_log_message(
                    "Producer", radio_reply(msg.text), "warn", msg.commandId, kind="miss"
                ),
            )
    except Exception as exc:  # never let one bad command kill the socket loop
        log.exception("user command failed: %s", msg.text)
        await manager.send(ws, error_message(str(exc), msg.commandId))
    finally:
        await emit_status("Producer", "idle", msg.commandId, None)
        session.command_finished()
        reset_session(token)


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
            try:
                raw = await ws.receive_json()
            except (ValueError, json.JSONDecodeError):
                # Malformed frame — the socket is still healthy; don't let the
                # exception escape and leak the session/observer/bridge.
                await ws.send_json(error_message("invalid JSON"))
                continue
            try:
                msg = client_message_adapter.validate_python(raw)
            except ValidationError as exc:
                command_id = raw.get("commandId") if isinstance(raw, dict) else None
                await ws.send_json(
                    error_message(
                        f"invalid message: {exc.error_count()} error(s)", command_id
                    )
                )
                continue
            if isinstance(msg, SceneState):
                scene_state.update(msg)
                session = manager.sessions.get(ws)
                if session is not None:
                    session.update_scene(msg)
            elif isinstance(msg, UserCommand):
                # LLM latency must never block the socket read loop
                asyncio.create_task(_handle_user_command(msg, ws))
            elif isinstance(msg, AgentToolResult):
                bridge = manager.bridges.get(ws)
                if bridge is not None:
                    bridge.resolve(msg)
            elif isinstance(msg, AgentAbort):
                session = manager.sessions.get(ws)
                if session is not None:
                    session.cancel_active_plan()
            elif isinstance(msg, Telemetry):
                await _handle_telemetry(msg)
    except WebSocketDisconnect:
        pass
    finally:
        # Always clean up — any exception path that skips this leaks the
        # SessionContext, its observer task, and the AgentBridge.
        manager.disconnect(ws)
        log.info("client disconnected (%d active)", len(manager.active))
