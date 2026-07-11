"""Anthropic tool definitions + helpers for the SceneAgent loop.

The four tools all execute in the browser via AgentBridge round trips;
run_commands payloads are pydantic-validated here first so schema mistakes
bounce back to the model without a round trip.
"""
from __future__ import annotations

from pydantic import TypeAdapter, ValidationError

from .schema import CommandPacket, SceneState
from .store_actions import STORE_ACTION_DOCS

_packet_list_adapter: TypeAdapter = TypeAdapter(list[CommandPacket])

RUN_COMMANDS_DESCRIPTION = """\
Execute one or more typed editor command packets. These are the preferred way
to change the scene: they clamp values to valid ranges and handle keyframe /
tween policy. Commands: SPAWN_OBJECT (primitives: box, sphere, cone, cylinder,
torus, plane, text), REMOVE_OBJECT, TRANSFORM_OBJECT, ANIMATE_OBJECT (motion
ids like float, drop, arc, pulse, bounce, orbit, turnaround), MOVE_CAMERA,
UPDATE_LIGHTS, SET_MATERIAL, UPDATE_FX (bloom/pixelate/cellShading/glitch/
dither), SET_KEYFRAMES, PLAYBACK, CALL_STORE_ACTION.
Each result string reports success or ERROR per packet; a fresh scene diff is
appended so you can verify the effect."""

CALL_STORE_ACTION_DESCRIPTION = (
    """\
Call any editor store action directly — the escape hatch for everything the
typed packets can't do (overlays, takes, camera-op mode, raw keyframe edits,
selection…). Args are positional and UNVALIDATED: a wrong call can break scene
state, so double-check signatures below.

"""
    + STORE_ACTION_DOCS
)

TOOLS: list[dict] = [
    {
        "name": "run_commands",
        "description": RUN_COMMANDS_DESCRIPTION,
        "input_schema": {
            "type": "object",
            "properties": {
                "packets": _packet_list_adapter.json_schema(),
            },
            "required": ["packets"],
        },
    },
    {
        "name": "call_store_action",
        "description": CALL_STORE_ACTION_DESCRIPTION,
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {"type": "string"},
                "args": {"type": "array"},
            },
            "required": ["action", "args"],
        },
    },
    {
        "name": "get_scene",
        "description": (
            "Get the full current scene briefing: objects with transforms and "
            "keyframe tracks, virtual camera, lighting, FX, playback state. "
            "Use it to re-orient or verify after several edits."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "capture_frame",
        "description": (
            "Capture a JPEG of the virtual camera's viewfinder (what the shot "
            "actually looks like, post-FX). Costly — use for visual "
            "verification of composition/lighting, not after every edit."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
]


def validate_run_commands(payload: dict) -> tuple[list[CommandPacket] | None, str | None]:
    """Returns (packets, None) or (None, error text for the model)."""
    try:
        packets = _packet_list_adapter.validate_python(payload.get("packets", []))
    except ValidationError as exc:
        return None, f"packet validation failed:\n{exc}"
    if not packets:
        return None, "run_commands requires at least one packet"
    return packets, None


def describe_tool_call(name: str, payload: dict) -> str:
    if name == "run_commands":
        packets = payload.get("packets", [])
        kinds = ", ".join(str(p.get("command", "?")) for p in packets[:6])
        return f"run_commands [{kinds}]" if kinds else "run_commands []"
    if name == "call_store_action":
        return f"store.{payload.get('action', '?')}(…)"
    return name


def _object_index(scene: SceneState | None) -> dict[str, tuple]:
    if scene is None:
        return {}
    return {
        o.id: (o.name, o.position, o.rotation, o.scale, len(o.tracks))
        for o in scene.objects
    }


def scene_diff(prev: SceneState | None, curr: SceneState | None) -> str:
    """Compact object-level diff appended to tool results (token control)."""
    if curr is None:
        return "scene: (no snapshot returned)"
    before = _object_index(prev)
    after = _object_index(curr)
    lines: list[str] = []
    for oid, (name, pos, _rot, _scale, tracks) in after.items():
        if oid not in before:
            lines.append(f"+ {name} ({oid}) at {tuple(round(v, 2) for v in pos)}")
        elif before[oid] != after[oid]:
            changed = []
            if before[oid][1] != pos:
                changed.append(f"pos {tuple(round(v, 2) for v in pos)}")
            if before[oid][2] != _rot:
                changed.append("rot")
            if before[oid][3] != _scale:
                changed.append("scale")
            if before[oid][4] != tracks:
                changed.append(f"{tracks} track(s)")
            lines.append(f"~ {name}: {', '.join(changed) or 'changed'}")
    for oid, (name, *_rest) in before.items():
        if oid not in after:
            lines.append(f"- {name} removed")
    if prev is not None and prev.virtualCamera != curr.virtualCamera:
        vc = curr.virtualCamera
        lines.append(
            f"~ camera pos {tuple(round(v, 2) for v in vc.position)} fov {vc.fov:.0f}"
        )
    if prev is not None and prev.lighting != curr.lighting:
        lines.append("~ lighting changed")
    lines.append(
        f"playhead {curr.currentTime:.1f}s/{curr.duration:.1f}s"
        f"{' PLAYING' if curr.isPlaying else ''}{' REC' if curr.isRolling else ''}"
        f" · {len(curr.objects)} object(s)"
    )
    return "scene: " + ("; ".join(lines) if lines else "no visible change")
