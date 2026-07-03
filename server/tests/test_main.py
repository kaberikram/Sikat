"""WebSocket endpoint smoke tests."""
import time

from fastapi.testclient import TestClient

from app.main import app


def test_healthz():
    with TestClient(app) as client:
        resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json()["ok"] is True


def test_websocket_invalid_message():
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "not_a_real_type", "text": "hello"})
            msg = ws.receive_json()
    assert msg["type"] == "error"


def test_websocket_user_command_broadcast():
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            ws.send_json(
                {"type": "user_command", "text": "add a red box", "commandId": "ws-1"}
            )
            seen: list[str] = []
            deadline = time.time() + 3.0
            while time.time() < deadline:
                msg = ws.receive_json()
                seen.append(msg["type"])
                if msg["type"] == "agent_command":
                    assert msg["packet"]["command"] == "SPAWN_OBJECT"
                    assert msg["packet"]["payload"]["color"] == "#ff3b30"
                    break
            else:
                raise AssertionError(f"expected agent_command, got {seen}")
