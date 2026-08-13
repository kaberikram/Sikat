"""Live Opus stream_plan smoke — skipped in CI when ANTHROPIC_API_KEY is unset."""
from __future__ import annotations

import asyncio
import logging
import os
import time
from pathlib import Path

import pytest
from dotenv import load_dotenv

from app import llm
from tests.helpers import scene_with

_NON_MUTATING = frozenset({"describe", "suggest", "clarify", "pitch"})

load_dotenv(Path(__file__).resolve().parents[2] / ".env")
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

pytestmark = pytest.mark.skipif(
    not os.environ.get("ANTHROPIC_API_KEY"),
    reason="ANTHROPIC_API_KEY unset",
)


@pytest.mark.parametrize("text", ["surprise me", "neon Tokyo"])
async def test_live_stream_plan_strong_yields_mutating_step(text: str, caplog):
    caplog.set_level(logging.ERROR, logger="director.llm")
    scene = scene_with("CORE_SPHERE")
    started = time.monotonic()
    mutating: list = []
    try:
        async with asyncio.timeout(15):
            async for event in llm.stream_plan(text, scene, tier="strong"):
                if (
                    isinstance(event, llm.Step)
                    and event.step.action not in _NON_MUTATING
                ):
                    mutating.append(event.step)
                    break
    except TimeoutError:
        if not mutating:
            pytest.fail(f"stream_plan exceeded 15s with zero mutating steps for {text!r}")
    except Exception as exc:
        pytest.fail(f"stream_plan error for {text!r}: {type(exc).__name__}: {exc}")

    elapsed = time.monotonic() - started
    if "stream_plan failed" in caplog.text:
        pytest.fail(f"stream_plan logged failure for {text!r} in {elapsed:.2f}s")

    assert mutating, f"zero mutating steps for {text!r} in {elapsed:.2f}s"
    assert elapsed < 15
