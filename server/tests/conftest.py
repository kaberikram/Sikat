"""Shared test fixtures for Director Mode server tests."""
from __future__ import annotations

import pytest

from app.agents.producer import Producer
from tests.helpers import scene_with


@pytest.fixture
def scene():
    return scene_with("CORE_SPHERE", "BOX_MDL_01")


@pytest.fixture
def producer(monkeypatch) -> Producer:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.delenv("DIRECTOR_LLM_PROVIDER", raising=False)
    return Producer()
