"""Pluggable LLM intent parsing for the Director's Assistant."""
from __future__ import annotations

import asyncio
import logging
import os

from . import session_context
from .performers import brief as performers_brief
from .scene_context import format_scene_brief
from .schema import IntentList, SceneFrame, SceneState

log = logging.getLogger("director.llm")

ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-5"
DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash"
DEEPSEEK_BASE_URL = "https://api.deepseek.com"

SYSTEM_PROMPT_TEMPLATE = """You are the Director's Assistant on a virtual film set (RADIO_EDIT.EXE).
Parse the director's instruction into structured intents. You see the scene
briefing below — it includes BASE transforms (editable values) and NOW
(sampled/interpolated at the playhead). Keyframe tracks describe animation.

## Output shape
Return JSON: {{"intents": [ {{...}}, ... ]}}
Each intent has `action` plus only relevant fields. Multiple intents for
compound instructions ("add X then dim lights" → 2 intents).

## Actions
| action | use when | key fields |
|--------|----------|------------|
| spawn | new primitive | primitive, color, name, text, position |
| remove | delete object | target (name) |
| transform | move/rotate/scale | target, position/rotation/scale, mode (absolute\\|relative), transition |
| animate | preset motion | target, preset (turnaround\\|orbit\\|bounce), transition |
| move_camera | frame shot | position, look_at (object name), fov, transition |
| update_lights | relight | ambient_color, ambient_intensity (0-4), key_color, key_intensity (0-8), key_position, background |
| set_material | surface look | target, color, emissive, emissive_intensity, opacity |
| update_fx | post stack | section (bloom\\|pixelate\\|cellShading\\|glitch\\|dither), fx_enabled, fx_set [{{key,value}}] |
| playback | transport | playback_action (play\\|pause\\|seek\\|record\\|cut), seek_time, playback_pause_after_seek |
| set_scene | whole mood | mood (noir\\|sunset\\|studio\\|neon) |
| describe | question only | describe_topic, describe_message |

## Set transport (film-set language)
- hold, freeze, stop → playback_action pause (preview hold)
- and action, camera rolling, start recording, we're rolling → playback_action record (start a take)
- cut, that's a cut, stop recording → playback_action cut (end take)
- play, go → playback_action play (preview timeline)
- back to one, top of scene → playback_action seek, seek_time 0, playback_pause_after_seek true
- print the take → describe (log only, no mutation)

## Numbered performers
Directors may address Agent 1–4. Assignments persist across takes.
- "Agent 1, you're on the sphere" → assign intent with addressee=1, target=sphere name
- "Agent 1, go in, scale it up" → transform with addressee=1 (target filled from assignment)
Use addressee (1–4) on mutating intents when the director names a performer.

## describe action (important)
Use `describe` when the director asks but does NOT command a change:
- "what's happening", "how's the bounce", "describe the shot"
Set describe_topic: scene|animation|lighting|fx|camera|object
Set describe_message: 1-3 sentences, present tense, cite NOW/sampled values
and track summaries. Offer one concrete next step as a question.
If they ask AND command ("too dark, fix it"), emit describe + update_lights.

## Scene grounding rules
- `target` MUST be an object name from the briefing when referring to existing objects
- Pronouns ("it", "that") → most recent target from history OR selectedId
- "selected" / "this one" → selectedId from briefing
- Rotations are RADIANS. Colors lowercase "#rrggbb".
- Durations ("over 3 seconds") → transition.durationSec
- Relative corrections ("a bit more", "go back") → mode "relative" on same target
- Prefer set_scene for whole-mood requests; individual actions otherwise
- NOW vs BASE: use NOW to answer "how does it look in motion"; use BASE for
  "move it to..." absolute placement unless they say relative

## Animation awareness
When describing or editing animation, reference:
- currentTime, isPlaying
- track keyframe counts and time ranges
- sampled NOW position vs BASE (if different, animation is active)
- preset names only for NEW animation (turnaround/orbit/bounce)

## FX awareness
FX applies to the VIEWFINDER (virtual camera), not the main viewport.
Enabled sections are listed under VIRTUAL CAMERA > fx.

## Vision
If an image is attached to this message, you can see the current viewfinder
frame (final look with post-processing). Use it for composition, exposure,
mood. Still emit structured intents — never freeform-only responses.

## Empty result
If nothing is actionable and it's not a question: {{"intents": []}}

---
SCENE BRIEFING:
{scene_brief}
{history_section}"""


def select_provider(frame: SceneFrame | None = None) -> str | None:
    """Resolve LLM provider, or None for the rule-grammar fallback.

    Hybrid auto-selection when both keys are present:
    - **Vision** (``frame`` set) → Anthropic (DeepSeek API is text-only)
    - **Text-only** → DeepSeek when available, else Anthropic

    ``DIRECTOR_LLM_PROVIDER`` (deepseek|anthropic|none) overrides text-only routing.
    Vision requests still prefer Anthropic unless the key is missing.
    """
    override = os.environ.get("DIRECTOR_LLM_PROVIDER")
    if override:
        value = override.strip().lower()
        if value == "none":
            return None
        if value in ("deepseek", "anthropic"):
            if frame is not None:
                if value == "deepseek":
                    log.warning(
                        "vision frame present but DIRECTOR_LLM_PROVIDER=deepseek; "
                        "routing to anthropic"
                    )
                if os.environ.get("ANTHROPIC_API_KEY"):
                    return "anthropic"
                log.warning("vision frame attached but ANTHROPIC_API_KEY not set")
                return None
            return value
        log.warning("unknown DIRECTOR_LLM_PROVIDER %r; using auto-selection", override)

    if frame is not None:
        if os.environ.get("ANTHROPIC_API_KEY"):
            return "anthropic"
        log.warning("vision frame attached but ANTHROPIC_API_KEY not set")
        return None

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
    scene_brief = format_scene_brief(scene) + "\n\n" + performers_brief()
    return SYSTEM_PROMPT_TEMPLATE.format(
        scene_brief=scene_brief,
        history_section=_history_section(),
    )


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


def _build_user_content(text: str, frame: SceneFrame | None):
    if frame is None:
        return text
    approx_bytes = len(frame.data) * 3 // 4
    log.debug(
        "vision frame attached: %dx%d ~%d bytes",
        frame.width,
        frame.height,
        approx_bytes,
    )
    return [
        {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": frame.mime,
                "data": frame.data,
            },
        },
        {"type": "text", "text": text},
    ]


def _parse_anthropic_sync(
    client,
    model: str,
    text: str,
    scene: SceneState | None,
    frame: SceneFrame | None = None,
) -> IntentList | None:
    message = client.messages.parse(
        model=model,
        max_tokens=2048,
        system=_system_prompt(scene),
        messages=[{"role": "user", "content": _build_user_content(text, frame)}],
        output_format=IntentList,
    )
    return message.parsed_output


def _parse_deepseek_sync(
    client,
    model: str,
    text: str,
    scene: SceneState | None,
    frame: SceneFrame | None = None,
) -> IntentList | None:
    if frame is not None:
        log.warning("DeepSeek path does not support vision; skipping frame attachment")
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


async def parse_intents(
    text: str,
    scene: SceneState | None,
    frame: SceneFrame | None = None,
) -> IntentList | None:
    """LLM parse; returns None on any failure so callers can fall back."""
    provider = select_provider(frame)
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
        return await asyncio.to_thread(parse_fn, client, model, text, scene, frame)
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
