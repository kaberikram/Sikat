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


def test_websocket_streams_presence_lifecycle():
    """The staged stream carries agent_status active → command → idle."""
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            ws.send_json(
                {"type": "user_command", "text": "add a red box", "commandId": "ws-2"}
            )
            events: list[tuple] = []
            deadline = time.time() + 3.0
            while time.time() < deadline:
                msg = ws.receive_json()
                if msg["type"] == "agent_status":
                    events.append((msg["type"], msg["agent"], msg["status"]))
                elif msg["type"] == "agent_command":
                    events.append((msg["type"], msg["packet"]["target_agent"]))
                if any(e[0] == "agent_status" and e[2] == "idle" for e in events):
                    break
            else:
                raise AssertionError(f"never saw idle status, got {events}")

    kinds = [e for e in events if e[0] != "agent_log"]
    assert ("agent_status", "AssetAnimator", "active") in kinds
    assert ("agent_command", "AssetAnimator") in kinds
    assert ("agent_status", "AssetAnimator", "idle") in kinds
    # active must precede the command, which must precede idle.
    order = [e for e in kinds if e[0] in ("agent_status", "agent_command")]
    assert order.index(("agent_status", "AssetAnimator", "active")) < order.index(
        ("agent_command", "AssetAnimator")
    )
    assert order.index(("agent_command", "AssetAnimator")) < order.index(
        ("agent_status", "AssetAnimator", "idle")
    )
