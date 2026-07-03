"""Anthropic-backed intent parsing for the Director's Assistant.

The client is lazy: without ANTHROPIC_API_KEY this module returns None and the
deterministic fallback parser takes over, so the whole pipeline runs key-free.
"""
from __future__ import annotations

import asyncio
import logging
import os

from .schema import IntentList, SceneState

log = logging.getLogger("director.llm")

DEFAULT_MODEL = "claude-sonnet-5"


def get_client():
    """Return an Anthropic client, or None when no API key is configured."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    try:
        import anthropic
    except ImportError:
        log.warning("anthropic package not installed; using fallback parser")
        return None
    return anthropic.Anthropic()


def _system_prompt(scene: SceneState | None) -> str:
    scene_lines = "(scene snapshot unavailable)"
    fov = 50.0
    if scene is not None:
        fov = scene.camera.fov
        if scene.objects:
            scene_lines = "\n".join(
                f'- id "{o.id}" name "{o.name}" at {tuple(o.position)}'
                for o in scene.objects
            )
        else:
            scene_lines = "(scene is empty)"
    return f"""You are the Director's Assistant for a virtual film studio. Parse the
director's spoken instruction into a list of structured intents. Each intent
has an `action` plus only the fields relevant to that action.

Actions and their fields:
- spawn: primitive (box|sphere|cone|cylinder|torus|plane|text), color (#rrggbb), name, text, position
- remove: target (object name)
- transform: target, position/rotation/scale, mode (absolute|relative), transition
- animate: target, preset (turnaround|orbit|bounce), transition
- move_camera: position, look_at (object name), fov, transition
- update_lights: ambient_color, ambient_intensity (0-4), key_color, key_intensity (0-8), key_position, background (#rrggbb)
- set_material: target, color, emissive, emissive_intensity, opacity
- update_fx: section (bloom|pixelate|cellShading|glitch|dither), fx_enabled, fx_set (list of {{key, value}})
- playback: playback_action (play|pause|seek), seek_time
- set_scene: mood (noir|sunset|studio|neon)

Rules:
- rotations are world-space euler XYZ in RADIANS
- colors are lowercase "#rrggbb" hex
- durations like "over 3 seconds" go into transition.durationSec
- prefer set_scene for whole-mood requests, individual actions otherwise
- target must be one of the scene object names below when the director refers
  to an existing object
- current camera fov: {fov}

Current scene objects:
{scene_lines}
"""


def _parse_sync(client, text: str, scene: SceneState | None) -> IntentList | None:
    message = client.messages.parse(
        model=os.environ.get("DIRECTOR_MODEL", DEFAULT_MODEL),
        max_tokens=2048,
        system=_system_prompt(scene),
        messages=[{"role": "user", "content": text}],
        output_format=IntentList,
    )
    return message.parsed_output


async def parse_intents(text: str, scene: SceneState | None) -> IntentList | None:
    """LLM parse; returns None on any failure so callers can fall back."""
    client = get_client()
    if client is None:
        return None
    try:
        return await asyncio.to_thread(_parse_sync, client, text, scene)
    except ImportError:
        log.warning("anthropic package not installed; using fallback parser")
        return None
    except Exception as exc:
        exc_name = type(exc).__name__
        if exc_name == "ValidationError":
            log.warning("LLM returned invalid structured output; falling back to rule parser")
        elif exc_name == "APIError" or "API" in exc_name:
            log.warning("LLM API error (%s); falling back to rule parser", exc_name)
        else:
            log.exception("LLM intent parse failed; falling back to rule parser")
        return None
