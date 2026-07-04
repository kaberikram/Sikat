"""Pluggable LLM intent parsing for the Director's Assistant.

Provider is selected at parse time (``DIRECTOR_LLM_PROVIDER`` override, else
DeepSeek when ``DEEPSEEK_API_KEY`` is present, else Anthropic when
``ANTHROPIC_API_KEY`` is present, else none). With no provider — or on any
failure — this module returns None and the deterministic fallback parser takes
over, so the whole pipeline runs key-free.

DeepSeek is OpenAI-compatible (base_url https://api.deepseek.com) and speaks
JSON mode (``response_format={"type": "json_object"}``); the response schema is
described in the prompt because DeepSeek has no strict json_schema mode. The
Anthropic path uses native structured outputs, unchanged.
"""
from __future__ import annotations

import asyncio
import logging
import os

from . import session_context
from .schema import IntentList, SceneState

log = logging.getLogger("director.llm")

ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-5"
DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash"
DEEPSEEK_BASE_URL = "https://api.deepseek.com"


def select_provider() -> str | None:
    """Resolve which provider to use, or None for the rule-grammar fallback.

    ``DIRECTOR_LLM_PROVIDER`` (deepseek|anthropic|none) forces the choice; an
    unknown value falls through to auto-selection by which API key is present.
    """
    override = os.environ.get("DIRECTOR_LLM_PROVIDER")
    if override:
        value = override.strip().lower()
        if value == "none":
            return None
        if value in ("deepseek", "anthropic"):
            return value
        log.warning("unknown DIRECTOR_LLM_PROVIDER %r; using auto-selection", override)
    if os.environ.get("DEEPSEEK_API_KEY"):
        return "deepseek"
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic"
    return None


def _model_for(provider: str) -> str:
    default = DEEPSEEK_DEFAULT_MODEL if provider == "deepseek" else ANTHROPIC_DEFAULT_MODEL
    return os.environ.get("DIRECTOR_MODEL", default)


def get_anthropic_client():
    """Anthropic client, or None when the key or SDK is missing."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    try:
        import anthropic
    except ImportError:
        log.warning("anthropic package not installed; using fallback parser")
        return None
    return anthropic.Anthropic()


def get_deepseek_client():
    """DeepSeek client (OpenAI SDK against the DeepSeek base URL), or None."""
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        return None
    try:
        from openai import OpenAI
    except ImportError:
        log.warning("openai package not installed; using fallback parser")
        return None
    return OpenAI(api_key=key, base_url=DEEPSEEK_BASE_URL)


def _history_section() -> str:
    hist = session_context.history()
    if not hist:
        return ""
    lines = "\n".join(
        f'- "{ex.text}" -> {", ".join(ex.intent_summaries) or "(no action)"}'
        for ex in hist
    )
    return f"""

Recent direction (oldest first):
{lines}

Follow-up rules:
- Pronouns ("it", "that", "this one") and an omitted target refer to the most
  recently mentioned object above.
- Small corrections like "go back a bit" or "a little more" are RELATIVE
  transforms on that same object (mode "relative"), not new absolute moves.
"""


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
{scene_lines}{_history_section()}"""


# Compact schema description + one worked example — required for DeepSeek JSON
# mode, which needs the shape described in the prompt (no strict json_schema).
_JSON_SCHEMA_HINT = """
Respond with a single JSON object of exactly this shape:
{"intents": [ {"action": "<one of the actions above>", ...only relevant fields...}, ... ]}
Example for "add a red box then dim the lights":
{"intents": [
  {"action": "spawn", "primitive": "box", "color": "#ff3b30"},
  {"action": "update_lights", "ambient_intensity": 0.3, "key_intensity": 0.7}
]}
If nothing is actionable, respond with {"intents": []}. Output JSON only."""


def _parse_anthropic_sync(
    client, model: str, text: str, scene: SceneState | None
) -> IntentList | None:
    message = client.messages.parse(
        model=model,
        max_tokens=2048,
        system=_system_prompt(scene),
        messages=[{"role": "user", "content": text}],
        output_format=IntentList,
    )
    return message.parsed_output


def _parse_deepseek_sync(
    client, model: str, text: str, scene: SceneState | None
) -> IntentList | None:
    system = _system_prompt(scene) + "\n\n" + _JSON_SCHEMA_HINT
    response = client.chat.completions.create(
        model=model,
        max_tokens=2048,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": text},
        ],
    )
    content = response.choices[0].message.content
    return IntentList.model_validate_json(content)


async def parse_intents(text: str, scene: SceneState | None) -> IntentList | None:
    """LLM parse; returns None on any failure so callers can fall back."""
    provider = select_provider()
    if provider is None:
        return None
    if provider == "deepseek":
        client = get_deepseek_client()
        parse_fn = _parse_deepseek_sync
    else:
        client = get_anthropic_client()
        parse_fn = _parse_anthropic_sync
    if client is None:
        return None
    model = _model_for(provider)
    try:
        return await asyncio.to_thread(parse_fn, client, model, text, scene)
    except ImportError:
        log.warning("LLM SDK not installed; using fallback parser")
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
