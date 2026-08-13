"""Liveness ping and the shared command budget.

The editor only sends `scene_state` when the snapshot changes, so an untouched
set sends nothing. Without an answered ping a proxy can close the connection
with neither side noticing: the browser keeps reporting the socket OPEN, sends
succeed into the void, and the command is simply gone.
"""
from fastapi.testclient import TestClient

from app.llm import COMMAND_BUDGET_SEC, LLM_HTTP_TIMEOUT_SEC
from app.main import app


def test_ping_is_answered():
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "ping", "timestamp": 1.0})
            msg = ws.receive_json()
    assert msg["type"] == "pong"
    assert isinstance(msg["timestamp"], float)


def test_ping_does_not_disturb_scene_state():
    """A ping must be inert — it is a liveness probe, not a command."""
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "ping", "timestamp": 1.0})
            assert ws.receive_json()["type"] == "pong"
            # The socket is still fully usable for real traffic afterwards.
            ws.send_json({"type": "ping", "timestamp": 2.0})
            assert ws.receive_json()["type"] == "pong"


def test_llm_timeout_outlasts_the_command_budget():
    """The server should notice a dead provider, not merely inherit the
    client's guess about one. Both SDKs otherwise default to ten minutes."""
    assert LLM_HTTP_TIMEOUT_SEC > COMMAND_BUDGET_SEC


def test_clients_carry_an_explicit_timeout(monkeypatch):
    """Regression guard for the real hang: the sync parse path runs under
    `asyncio.to_thread`, which cannot be cancelled, so a provider connection
    with no timeout pins a worker thread long after the director moved on."""
    import app.llm as llm_module

    captured: dict = {}

    class FakeAnthropic:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    fake_sdk = type("m", (), {"Anthropic": FakeAnthropic, "AsyncAnthropic": FakeAnthropic})
    monkeypatch.setitem(__import__("sys").modules, "anthropic", fake_sdk)

    llm_module.get_anthropic_client()
    assert captured.get("timeout") == LLM_HTTP_TIMEOUT_SEC

    captured.clear()
    llm_module.get_async_anthropic_client()
    assert captured.get("timeout") == LLM_HTTP_TIMEOUT_SEC
