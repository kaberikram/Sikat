"""SceneAgent — the autonomous multi-step director loop (Anthropic-only).

Given a high-level goal, runs a Claude tool-use loop whose tools execute in
the browser over the AgentBridge: plan → act → observe (scene diff / brief /
viewfinder frame) → iterate, until the model stops calling tools, a cap trips,
or the user aborts ("cut" → agent_abort → session cancel event).
"""
from __future__ import annotations

import asyncio
import logging
import os
import time

from ..agent_bridge import AgentBridge, BridgeClosed
from ..agent_tools import TOOLS, describe_tool_call, scene_diff, validate_run_commands
from ..llm import ANTHROPIC_DEFAULT_MODEL, get_async_anthropic_client
from ..scene_context import format_scene_brief
from ..schema import SceneFrame, SceneState, plan_update_message

log = logging.getLogger("director.scene_agent")

DEFAULT_MAX_TURNS = 16
WALL_CLOCK_SEC = 300.0

AGENT_SYSTEM = """\
You are the Director on a virtual film set (RADIO_EDIT.EXE) — and right now
you're running the whole floor yourself. The human gave you a high-level goal;
you autonomously plan, execute, verify, and iterate until it's met.

Conventions:
- Rotations are world-space euler XYZ in RADIANS. Colors are "#rrggbb".
- The stage is a disc at the origin, radius 25; keep action near the center
  unless directed otherwise. +Y is up.
- The virtual camera is the SHOT — what gets recorded. Compose it.

How to work:
- Prefer run_commands (typed, value-clamped) for scene changes; use
  call_store_action for anything the packets can't reach (overlays, takes,
  playhead, raw keyframes). Batch related packets into one run_commands call.
- Every tool result carries a compact scene diff. Call get_scene when you need
  the full picture; call capture_frame to SEE the shot before declaring
  composition/lighting done — but sparingly, frames are expensive.
- Iterate: if the diff or frame shows the result is off, fix it.
- Narrate tersely: any text you emit between tool calls is shown to the user
  as film-set radio chatter (≤ 12 words, present tense).
- When the goal is met, stop calling tools and give a one-line wrap report.
"""


def agent_mode_requested(text: str) -> bool:
    """Heuristic router: explicit cues or a big multi-step ask → agent loop."""
    t = text.strip().lower()
    if t.startswith("just "):
        return False
    if os.environ.get("DIRECTOR_AGENT_MODE", "").lower() in ("off", "0", "false"):
        return False
    explicit = ("agent mode", "take over", "you direct", "do it all")
    if any(cue in t for cue in explicit):
        return True
    leading = ("build ", "block out ", "set up ", "stage ", "create a scene", "make a scene")
    scene_words = ("scene", "sequence", "takes", "shot", "set")
    if t.startswith(leading) and any(w in t for w in scene_words):
        return True
    # ≥3 sequenced clauses reads as a plan, not a command.
    separators = t.count(" then ") + t.count(", ") + t.count(" and then ")
    return separators >= 3


def _max_turns() -> int:
    try:
        return max(1, int(os.environ.get("DIRECTOR_AGENT_MAX_TURNS", DEFAULT_MAX_TURNS)))
    except ValueError:
        return DEFAULT_MAX_TURNS


def _goal_content(text: str, scene: SceneState | None, frame: SceneFrame | None):
    goal = (
        f"GOAL: {text}\n\nCurrent scene briefing:\n{format_scene_brief(scene)}"
    )
    if frame is None:
        return goal
    return [
        {
            "type": "image",
            "source": {"type": "base64", "media_type": frame.mime, "data": frame.data},
        },
        {"type": "text", "text": goal},
    ]


def _frame_result_content(frame: SceneFrame | None, diff: str):
    if frame is None:
        return [{"type": "text", "text": f"frame capture failed\n{diff}"}]
    return [
        {
            "type": "image",
            "source": {"type": "base64", "media_type": frame.mime, "data": frame.data},
        },
        {"type": "text", "text": diff},
    ]


async def run_goal(
    text: str,
    scene: SceneState | None,
    frame: SceneFrame | None,
    bridge: AgentBridge,
    command_id: str,
    emit_log,
    emit_status,
    emit_plan_update,
    cancel_event: asyncio.Event,
) -> bool:
    """Returns True when the loop ran (regardless of outcome)."""
    client = get_async_anthropic_client()
    if client is None:
        return False
    model = os.environ.get(
        "DIRECTOR_STRONG_MODEL",
        os.environ.get("DIRECTOR_QUALITY_MODEL", ANTHROPIC_DEFAULT_MODEL),
    )
    max_turns = _max_turns()
    deadline = time.monotonic() + WALL_CLOCK_SEC

    # cache_control on system + tools: identical prefix across every turn.
    system = [{"type": "text", "text": AGENT_SYSTEM, "cache_control": {"type": "ephemeral"}}]
    tools = [dict(t) for t in TOOLS]
    tools[-1]["cache_control"] = {"type": "ephemeral"}

    messages: list[dict] = [{"role": "user", "content": _goal_content(text, scene, frame)}]
    prev_scene = scene
    stopped = ""

    await emit_status("Producer", "active", command_id, "agent mode — taking the floor")
    await emit_plan_update(
        plan_update_message(
            command_id, status="planning", say="agent mode: working the goal",
            mode="execute", steps_total=max_turns,
        )
    )

    for turn in range(max_turns):
        if cancel_event.is_set():
            stopped = "cut by the director"
            break
        if time.monotonic() > deadline:
            stopped = "out of time (wall clock)"
            break

        try:
            resp = await client.messages.create(
                model=model,
                max_tokens=4096,
                system=system,
                tools=tools,
                messages=messages,
            )
        except Exception as exc:  # surface API failures, don't kill the socket
            log.exception("scene agent LLM call failed")
            await emit_log("Producer", f"agent stalled: {exc}", "error")
            break

        for block in resp.content:
            if block.type == "text" and block.text.strip():
                await emit_plan_update(
                    plan_update_message(
                        command_id, status="step_start", say=block.text.strip()[:120],
                        mode="execute", step_index=turn + 1, steps_total=max_turns,
                    )
                )

        tool_uses = [b for b in resp.content if b.type == "tool_use"]
        if not tool_uses:
            final = next(
                (b.text.strip() for b in resp.content if b.type == "text" and b.text.strip()),
                "that's the take",
            )
            await emit_log("Producer", final, "info")
            break

        messages.append({"role": "assistant", "content": resp.content})
        results: list[dict] = []
        for tu in tool_uses:
            payload = tu.input if isinstance(tu.input, dict) else {}
            await emit_log(
                "Producer", f"[{turn + 1}/{max_turns}] {describe_tool_call(tu.name, payload)}", "info"
            )

            if tu.name == "run_commands":
                packets, err = validate_run_commands(payload)
                if err is not None:
                    results.append(
                        {"type": "tool_result", "tool_use_id": tu.id, "is_error": True, "content": err}
                    )
                    continue
                payload = {"packets": [p.model_dump() for p in packets]}

            try:
                out = await bridge.call(tu.name, payload, command_id)
            except BridgeClosed:
                stopped = "client disconnected"
                results.append(
                    {"type": "tool_result", "tool_use_id": tu.id, "is_error": True,
                     "content": "client disconnected"}
                )
                break
            except asyncio.TimeoutError:
                results.append(
                    {"type": "tool_result", "tool_use_id": tu.id, "is_error": True,
                     "content": "tool call timed out in the client (20s)"}
                )
                continue

            diff = scene_diff(prev_scene, out.scene)
            if out.scene is not None:
                prev_scene = out.scene

            if tu.name == "capture_frame":
                content = _frame_result_content(out.frame, diff)
            elif tu.name == "get_scene":
                content = f"{format_scene_brief(out.scene)}\n{diff}"
            else:
                lines = "\n".join(out.results) if out.results else "(no result)"
                content = f"{lines}\n{diff}"

            results.append(
                {"type": "tool_result", "tool_use_id": tu.id, "is_error": not out.ok,
                 "content": content}
            )

        messages.append({"role": "user", "content": results})
        if stopped:
            break

    if stopped:
        await emit_log("Producer", f"agent stopped — {stopped}", "warn")
    await emit_plan_update(plan_update_message(command_id, status="done"))
    return True
