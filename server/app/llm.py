"""Pluggable LLM intent parsing for the Director's Assistant."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from dataclasses import dataclass
from typing import AsyncIterator, Awaitable, Callable, Literal

from . import session_context
from .performers import brief as performers_brief
from .performers import crew_brief
from .prompts import build_plan_prompt
from .scene_context import format_scene_brief
from .schema import DirectorPlan, Intent, IntentList, PlanMode, PlanStep, SceneFrame, SceneState

log = logging.getLogger("director.llm")

ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-5"
"""Non-reasoning Sonnet — choreo/refine tier. Avoid *-max / extended-thinking IDs."""
ANTHROPIC_FAST_DEFAULT_MODEL = "claude-haiku-4-5"
DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash"
"""Fast tier — reserved for optional future preview helpers; not used for animate refine."""
DEEPSEEK_BASE_URL = "https://api.deepseek.com"

SYSTEM_PROMPT_TEMPLATE = """You are the Director's Assistant on a virtual film set (RADIO_EDIT.EXE).
Parse the director's instruction into structured intents. You see the scene
briefing below — it includes BASE transforms (editable values) and NOW
(sampled/interpolated at the playhead). Keyframe tracks describe animation.

## Output shape
Return JSON: {{"intents": [ {{...}}, ... ]}}
Each intent has `action` plus only relevant fields. Multiple intents for
compound instructions ("add X then dim lights" → 2 intents).

When SCRIPT SUPERVISOR NOTES mark a clause as handled, emit **no** intent for
that clause — grammar already executed it. Your whole attention is on the
creative / motion / unhandled clauses: richer `say` lines and tuned motion params.

## say (every intent, required)
Every intent — mutating or describe — includes `say`: a ≤8 word, present-tense
line in the voice of film-set radio chatter, read aloud on the crew's cursor
the instant the intent completes (fills the parse-latency gap). Reference the
SPECIFICS of this intent — the object, the motion, the numbers — never a
generic verb like "animating" or "moving". Never repeat a phrasing you've
already used this session (vary word choice, structure, energy each take).
Examples: "taking the sphere up on a three-count", "warming the key, half
stop", "box in, red, dead center", "cutting bloom, we're flat now".

## Actions
| action | use when | key fields |
|--------|----------|------------|
| spawn | new primitive | primitive, color, name, text, position |
| remove | delete object | target (name) |
| transform | move/rotate/scale | target, position/rotation/scale, mode (absolute\\|relative), transition |
| animate | motion on object | target, motion OR track_property + track_keyframes (prefer for unique choreography), motion_params, animate_repeat, transition |
| move_camera | frame shot | position, rotation, look_at (ONLY when explicitly framing), fov, transition |

## Camera / look-at rules (IMPORTANT)
- `look_at` / framing ONLY when the director says **look at**, **frame**, **point at**, **aim at**.
- Zoom / dolly / FOV / "closer" / "wider" → change **fov** and/or **position** only — do NOT set look_at.
- Moving an object (transform/animate) is NOT a camera command — never emit move_camera for object moves.
- When framing IS requested, look_at = object name; client aims at the object's **current** path position.
- Preserve existing camera rotation when only adjusting fov unless they ask to reframe.
| update_lights | relight | ambient_color, ambient_intensity (0-4), key_color, key_intensity (0-8), key_position, background |
| set_material | surface look | target, color, emissive, emissive_intensity, opacity |
| update_fx | post stack | section (bloom\\|pixelate\\|cellShading\\|glitch\\|dither), fx_enabled, fx_set [{{key,value}}] |
| playback | transport | playback_action (play\\|pause\\|seek\\|record\\|cut\\|loop_on\\|loop_off), seek_time, playback_pause_after_seek |
| set_scene | whole mood | mood (noir\\|sunset\\|studio\\|neon\\|shine) |

### shine mood (product showcase macro)
`mood: "shine"` expands into a full trailer beat: hero object (named target, or
selection, or spawned sphere) + RADIO_EDIT title card + studio/bloom lighting +
camera frame + product spin + title rise/pulse + play. Use it for "showcase",
"product shot", "hero shot", "make it shine", trailer-style requests — even
embedded in a longer sentence ("animate the sphere like a product showcase").
Set `target` to the named hero object when the director names one.
**Layering**: emit `set_scene mood=shine` FIRST, then optionally 1-3 extra
intents that adapt the requested style on top of the macro (e.g. "anime
style" → snappier motion params / a glitch or dither fx pass / punchier
colors; "moody showcase" → follow with an update_lights tweak). The macro is
the base; extra intents are the variation layered after it.

### Complaints / vague adjustments (lighting & fx)
Directors often complain rather than command precisely: "too bright", "not
enough contrast", "bloom's way too much", "tone the glow down". Infer BOTH
direction and rough magnitude from the wording, don't require exact vocabulary:
- The desired change moves AWAY from the complained-about quality — "too
  bright" means dim it, "too dark" means brighten it (don't just amplify
  whatever adjective appears in the sentence).
- Grade the degree from qualifiers: "a little"/"slightly" → a small nudge;
  unqualified "too much"/"reduce it" → a moderate change; "way too
  much"/"so much"/"a lot" → a strong change. Pick ambient/key intensity or
  fx_set values proportionally rather than always snapping to an extreme.
- A single sentence can contain more than one complaint ("it's too bright
  and the bloom is way too much") — emit one intent per distinct target
  (update_lights and update_fx), each with its own inferred direction/degree.
| describe | question only | describe_topic, describe_message |
| clarify | genuinely ambiguous target (2+ near-equal matches) | clarify_question, clarify_options — server holds clauses until answered |
| suggest | optional follow-up pitch after mutating intents | say, suggestion_command — omit when nothing worth pitching |

Optionally end the intents array with ONE suggest intent (action suggest, say, suggestion_command)
when a natural follow-up would help (e.g. after spawn: "want me to animate it?").
Omit entirely when nothing is worth pitching. Never emit suggest before mutating intents.

## Set transport (film-set language)
- hold, freeze, stop → playback_action pause (preview hold). When animation is playing on the last target, also set freeze_motion true to freeze the clip at its current pose (not just pause transport).
- and action, camera rolling, start recording, we're rolling → playback_action record (start a take)
- cut, that's a cut, stop recording → playback_action cut (end take)
- play, go → playback_action play (preview timeline)
- loop, loop it, keep looping, on repeat → playback_action loop_on (timeline repeats)
- play once, no loop → playback_action loop_off
- back to one, top of scene → playback_action seek, seek_time 0, playback_pause_after_seek true
- print the take → describe (log only, no mutation)

## Numbered performers
Directors may address Agent 1–4. Assignments persist across takes.
- "Agent 1, you're on the sphere" → assign intent with addressee=1, target=sphere name
- "Agent 1, go in, scale it up" → transform with addressee=1 (target filled from assignment)
Use addressee (1–4) on mutating intents when the director names a performer.
Each performer has a persona and recent-work memory (see PERFORMERS below) —
when a numbered performer acts, honor their persona and recent work in both
the motion choice and the `say` line. "Agent 2, again but bigger" means
relative to AGENT 2's own last action (their `recent:` list), not the last
action overall.

## describe action (important)
Use `describe` when the director asks but does NOT command a change:
- "what's happening", "how's the bounce", "describe the shot"
Set describe_topic: scene|animation|lighting|fx|camera|object
Set describe_message: 1-3 sentences, present tense, cite NOW/sampled values
and track summaries. Offer one concrete next step as a question.
If they ask AND command ("too dark, fix it"), emit describe + update_lights.

## Conversation / presence (not set mutation)
Greetings, thanks, "you there?", small talk, jokes, or presence checks are
**not** empty — reply in character as set radio:
- Emit ONE intent: `action: "describe"`, `describe_topic: "scene"`,
  `describe_message`: a short crew radio line (≤12 words), plus matching `say`.
- Do **not** spawn/transform/animate for chitchat. No scene mutation.
- Unclear but on-set ("make it better", "fix that") → `clarify` with a
  concrete question, not silence.
Examples: "hey director", "standing by — what's the call?", "copy, ears on".

## Scene grounding rules
- `target` MUST be an object name from the briefing when referring to existing objects
- Pronouns ("it", "that") → most recent target from history OR selectedId
- "selected" / "this one" → selectedId from briefing
- Rotations are RADIANS. Colors lowercase "#rrggbb".
- Durations ("over 3 seconds") → transition.durationSec
- "snap", "instantly", "instant" → omit transition (client snaps immediately)
- Relative corrections ("a bit more", "go back") → mode "relative" on same target
- Prefer set_scene for whole-mood requests; individual actions otherwise
- NOW vs BASE: use NOW to answer "how does it look in motion"; use BASE for
  "move it to..." absolute placement unless they say relative

## Animation — your job is to CHOREOGRAPH, not pick a preset

The client has ~20 parametric motion ids (bounce, wander, orbit, …) as a **fallback**
for simple shorthand. When the director describes *how it should feel*, a path,
a journey, emotion, or anything non-literal — **compose custom keyframes**.

### Prefer custom keyframes (most creative)
Use `action: animate` with:
- `track_property`: "position" | "rotation" | "scale"
- `track_keyframes`: [{{"time": 0, "value": [x,y,z]}}, ...]  (4–16 points, times in seconds)
- Values are **absolute world-space** positions. Read BASE position from the briefing,
  then place keyframes across the STAGE floor (stay inside STAGE radius unless they
  say leave the stage). Use Y from BASE unless they ask for height/air.
- `animate_repeat: true` when they say loop/repeat.

Example — "make the ball nervous, darting around the stage":
{{"action": "animate", "target": "CORE_SPHERE", "track_property": "position",
  "track_keyframes": [
    {{"time": 0, "value": [0, 0.5, 0]}},
    {{"time": 0.4, "value": [8, 0.6, -5]}},
    {{"time": 0.9, "value": [-6, 0.5, 7]}},
    {{"time": 1.5, "value": [3, 0.7, -10]}},
    {{"time": 2.2, "value": [0, 0.5, 0]}}
  ]}}

Example — "swoop low left then rise over center":
{{"action": "animate", "target": "HERO", "track_property": "position",
  "track_keyframes": [
    {{"time": 0, "value": [2, 1, 4]}},
    {{"time": 0.8, "value": [-12, 0.3, -8]}},
    {{"time": 1.6, "value": [0, 3.5, 0]}},
    {{"time": 2.4, "value": [2, 1, 4]}}
  ]}}

### Motion ids (simple shorthand — still vary every take)
Use `motion` + `motion_params` when the director uses a literal verb (bounce, drop, spin).
**Never use identical defaults twice** — pick hops, height, decay, amplitude from context
and the STAGE size. Example "bounce the ball" → hops 2-4, height ~1-2.5, slight drift.
Only use track_keyframes when the path is scenic/emotional; bounce can stay motion+bounce params.

| motion | feel | key params |
|--------|------|------------|
| bounce | hops on Y | height (0.5-4), hops (1-5), decay (0.2-0.9) |
| float | gentle hover | amplitude (0.1-1), frequency (0.5-3) |
| drop | fall from above | height (1-5), easing via fast/slow language |
| rise | lift up | height |
| pulse | scale breathe | amplitude (0.1-0.5), frequency |
| sway | side-to-side | amplitude, frequency |
| spin / turnaround | rotate | turns (0.25-4), axis (0=x,1=y,2=z) |
| orbit | small circle in place (default) OR stage-wide ring if "orbit the stage" | pivot=1 for stage, radius optional |
| wander | explore the stage floor — unique path each time, stays inside radius | waypoints (3-8) |
| drift | slow travel + bob across stage | span, amplitude |
| arc | parabolic toss | span, height |
| pop | snappy reveal | height |
| shake | impact wobble | amplitude, frequency |
| figure8 | lemniscate path | radius / amplitude |

Drop vs bounce (critical — they must look different):
- drop: object starts ABOVE rest position, falls ONCE with gravity, lands and STOPS. No repeated hops.
- bounce: object stays on ground, hops 2-4 times with shrinking parabolic arcs.
- "three hops" / "high bounce" → bounce with hops=3, height=2.5+
- "move the ball freely" / "wander" / "explore the stage" → motion wander (NOT orbit)
- "orbit" alone = small local circle; "orbit the stage" = pivot 1, big ring

Do NOT default to orbit for vague "move it" / "make it move" — compose keyframes
that match what they said. Read STAGE center + radius from the briefing.

## Custom motion (fallback note)
`track_keyframes` overrides `motion` when both are set. Never emit freeform-only text.

Also use motion + motion_params for literal one-word verbs; combine params when obvious
(e.g. float + amplitude 0.6 + frequency 2.5 for energetic hover).

Legacy preset names (turnaround/orbit/bounce) still work but prefer track_keyframes for anything descriptive.

## Animation awareness
When describing or editing animation, reference:
- currentTime, isPlaying
- track keyframe counts and time ranges (position kf: lines in briefing = the live path)
- sampled NOW position vs BASE (if different, animation is active)

## Follow-up / layering (CRITICAL — read existing tracks first)
When an object already has **position keyframes** (a path, wander, drift):
- "bounce while moving", "bounce on the path", "keep moving but bounce", "add bounce"
  → Keep the horizontal path. Emit `motion: bounce` with tuned motion_params OR emit
  `track_keyframes` that follow the existing path positions with added Y hops.
  The client auto-composites bounce/float/shake onto an existing path when you emit
  motion bounce — you do NOT need to rebuild XZ from scratch.
- NEVER snap back to BASE position for a follow-up bounce — that erases the path.
- Read the object's `position kf:` line in the briefing and preserve its XZ journey.
- For brand-new motion on a static object, use BASE position as usual.

When describing or editing animation, also reference:
- motion + motion_params for NEW animation on objects with no position track yet

## FX awareness
FX applies to the VIEWFINDER (virtual camera), not the main viewport.
Enabled sections are listed under VIRTUAL CAMERA > fx.

## Vision
If an image is attached to this message, you can see the current viewfinder
frame (final look with post-processing). Use it for composition, exposure,
mood. Still emit structured intents — never freeform-only responses.

## Empty result
Return {{"intents": []}} **only** for true noise / empty string / gibberish
with no conversational content. Never empty for greetings, thanks, presence,
or vague on-set talk — use describe or clarify instead.

---
SCENE BRIEFING:
{scene_brief}
{history_section}{parse_hints}"""


def select_provider(frame: SceneFrame | None = None) -> str | None:
    """Resolve LLM provider for parse/stream (quality tier), or None for grammar-only.

    Hybrid auto-selection when both keys are present:
    - **Vision** (``frame`` set) → Anthropic (DeepSeek API is text-only)
    - **Text-only** → Anthropic when available (animate/choreo refine), else DeepSeek

    Phase G routing: Sonnet choreographs; grammar owns deterministic clauses,
    LLM owns creative/motion.

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

    # Quality tier: prefer Anthropic for choreo / structured intent parse.
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic"
    if os.environ.get("DEEPSEEK_API_KEY"):
        return "deepseek"
    return None


def select_tier(
    frame: SceneFrame | None,
    *,
    escalated: bool,
) -> tuple[Literal["anthropic", "deepseek"], str] | None:
    """Select the planning tier.

    The normal agent loop uses Anthropic vision-capable models. DeepSeek remains
    an explicit compatibility path for keyless deployments only.
    """
    override = os.environ.get("DIRECTOR_LLM_PROVIDER", "").strip().lower()
    if override == "none":
        return None
    if override == "deepseek":
        if frame is not None:
            log.warning("DeepSeek planning cannot use a vision frame")
            return None
        if not os.environ.get("DEEPSEEK_API_KEY"):
            return None
        return "deepseek", os.environ.get("DIRECTOR_FAST_MODEL", DEEPSEEK_DEFAULT_MODEL)
    if override not in ("", "anthropic"):
        log.warning("unknown DIRECTOR_LLM_PROVIDER %r; using Anthropic planning", override)
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    if escalated:
        return "anthropic", os.environ.get(
            "DIRECTOR_STRONG_MODEL",
            os.environ.get("DIRECTOR_QUALITY_MODEL", ANTHROPIC_DEFAULT_MODEL),
        )
    return "anthropic", os.environ.get("DIRECTOR_FAST_MODEL", ANTHROPIC_FAST_DEFAULT_MODEL)


def _model_for(provider: str) -> str:
    if provider == "deepseek":
        return os.environ.get(
            "DIRECTOR_FAST_MODEL",
            os.environ.get("DIRECTOR_MODEL", DEEPSEEK_DEFAULT_MODEL),
        )
    return os.environ.get(
        "DIRECTOR_QUALITY_MODEL",
        os.environ.get("DIRECTOR_MODEL", ANTHROPIC_DEFAULT_MODEL),
    )


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


def get_async_anthropic_client():
    """Async Anthropic client for streaming, or None when key/SDK is missing."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    try:
        import anthropic
    except ImportError:
        log.warning("anthropic package not installed; using fallback parser")
        return None
    return anthropic.AsyncAnthropic()


def get_async_deepseek_client():
    """Async DeepSeek client (OpenAI SDK against the DeepSeek base URL), or None."""
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        return None
    try:
        from openai import AsyncOpenAI
    except ImportError:
        log.warning("openai package not installed; using fallback parser")
        return None
    return AsyncOpenAI(api_key=key, base_url=DEEPSEEK_BASE_URL)


def _history_section() -> str:
    hist = session_context.history()
    recent = list(session_context.get_session().recent_notes)
    parts: list[str] = []
    if hist:
        lines = "\n".join(
            f'- "{ex.text}" -> {", ".join(ex.intent_summaries) or "(no action)"}'
            for ex in hist
        )
        parts.append(f"Recent direction (oldest first):\n{lines}")
    if recent:
        parts.append(
            "Recent crew radio lines (do NOT repeat phrasing):\n"
            + ", ".join(recent[-8:])
        )
    if not parts:
        return ""
    return "\n\n" + "\n\n".join(parts) + """

Follow-up rules:
- Pronouns ("it", "that", "this one") and an omitted target refer to the most
  recently mentioned object above.
- Small corrections like "go back a bit" or "a little more" are RELATIVE
  transforms on that same object (mode "relative"), not new absolute moves.
"""


def _system_prompt(scene: SceneState | None, hints: str | None = None) -> str:
    scene_brief = format_scene_brief(scene) + "\n\n" + performers_brief() + "\n\n" + crew_brief()
    parse_hints = f"\n\n{hints}" if hints else ""
    return SYSTEM_PROMPT_TEMPLATE.format(
        scene_brief=scene_brief,
        history_section=_history_section(),
        parse_hints=parse_hints,
    )


# Compact schema description + one worked example — required for DeepSeek JSON
# mode, which needs the shape described in the prompt (no strict json_schema).
_JSON_SCHEMA_HINT = """
Respond with a single JSON object of exactly this shape:
{"intents": [ {"action": "<one of the actions above>", "say": "<in-character radio line>", ...only relevant fields...}, ... ]}
Example for "add a blue sphere and make it float":
{"intents": [
  {"action": "spawn", "primitive": "sphere", "color": "#0a84ff", "say": "sphere in, blue, stage left"},
  {"action": "animate", "target": "SPHERE_SPAWN", "motion": "float", "motion_params": {"amplitude": 0.4, "frequency": 1.4}, "animate_repeat": true, "say": "gentle hover on the blue"}
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


def _coerce_intent_list(content: str) -> IntentList | None:
    """Best-effort repair when the model returns almost-valid JSON."""
    if not content:
        return None
    try:
        return IntentList.model_validate_json(content)
    except Exception:
        pass
    match = re.search(r"\{[\s\S]*\}", content)
    if not match:
        return None
    try:
        data = json.loads(match.group())
    except json.JSONDecodeError:
        return None
    if isinstance(data, dict) and "intents" not in data and "action" in data:
        data = {"intents": [data]}
    try:
        return IntentList.model_validate(data)
    except Exception:
        return None


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
    content = response.choices[0].message.content or ""
    parsed = _coerce_intent_list(content)
    if parsed is not None:
        return parsed
    # One retry with a tighter instruction — transient format slips happen often.
    retry = client.chat.completions.create(
        model=model,
        max_tokens=2048,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": text},
            {
                "role": "user",
                "content": (
                    'Return ONLY {"intents":[...]} JSON. Each intent needs "action". '
                    "Use object names from the scene briefing for targets. "
                    "Skip clauses marked handled in supervisor notes."
                ),
            },
        ],
    )
    return _coerce_intent_list(retry.choices[0].message.content or "")


async def parse_intents(
    text: str,
    scene: SceneState | None,
    frame: SceneFrame | None = None,
    hints: str | None = None,
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
    started = time.monotonic()
    try:
        result = await asyncio.to_thread(parse_fn, client, model, text, scene, frame)
        log.info(
            "parse_intents via %s (%s) took %.2fs",
            provider,
            model,
            time.monotonic() - started,
        )
        return result
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


# ---------------------------------------------------------------------------
# Streaming intents — token-by-token parse so packets ride out per-intent
# instead of waiting for the whole response (Phase 3).
# ---------------------------------------------------------------------------


def extract_complete_intents(buffer: str, consumed: int) -> tuple[list[str], int]:
    """Scan ``buffer`` for newly-completed top-level objects inside the
    top-level ``"intents": [...]`` array.

    Pure and idempotent: rescans from the start of the buffer every call (the
    buffer is small — bounded by max_tokens) and returns only the raw JSON
    slices whose closing brace lies beyond ``consumed``, plus the new consumed
    offset. Tracks brace/bracket depth and in-string/escape state so nested
    objects (e.g. ``track_keyframes`` entries) and braces inside string values
    never get misread as array elements.
    """
    slices: list[str] = []
    depth = 0
    arr_depth: int | None = None
    in_string = False
    escape = False
    obj_start_stack: list[int] = []
    new_consumed = consumed

    for i, ch in enumerate(buffer):
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            continue
        if ch == "[":
            if arr_depth is None:
                arr_depth = depth + 1
            depth += 1
            continue
        if ch == "{":
            if arr_depth is not None and depth == arr_depth:
                obj_start_stack.append(i)
            depth += 1
            continue
        if ch == "]":
            depth -= 1
            continue
        if ch == "}":
            depth -= 1
            if arr_depth is not None and depth == arr_depth and obj_start_stack:
                start = obj_start_stack.pop()
                end = i + 1
                if end > consumed:
                    slices.append(buffer[start:end])
                    new_consumed = end
            continue

    return slices, new_consumed


def extract_complete_array_items(
    buffer: str,
    consumed: int,
    *,
    key: str = "steps",
) -> tuple[list[str], int]:
    """Return completed object slices only from the requested top-level array."""
    match = re.search(rf'"{re.escape(key)}"\s*:\s*\[', buffer)
    if not match:
        return [], consumed
    array_start = buffer.find("[", match.start(), match.end())
    if array_start < 0:
        return [], consumed

    slices: list[str] = []
    depth = 0
    in_string = False
    escape = False
    object_start: int | None = None
    new_consumed = consumed
    for index in range(array_start, len(buffer)):
        char = buffer[index]
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "[":
            depth += 1
        elif char == "{":
            if depth == 1:
                object_start = index
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 1 and object_start is not None:
                end = index + 1
                if end > consumed:
                    slices.append(buffer[object_start:end])
                    new_consumed = end
                object_start = None
        elif char == "]":
            depth -= 1
            if depth == 0:
                break
    return slices, new_consumed


def _validate_intent_slice(raw: str) -> Intent | None:
    try:
        return Intent.model_validate_json(raw)
    except Exception:
        log.warning("skipping invalid streamed intent slice: %s", raw[:160])
        return None


def extract_partial_preview_fields(buffer: str) -> dict[str, str | int] | None:
    """Scan streaming JSON for early intent fields before the object closes."""
    fields: dict[str, str | int] = {}
    for key in ("target", "action", "motion", "say"):
        match = re.search(rf'"{key}"\s*:\s*"([^"]*)"', buffer)
        if match and match.group(1):
            fields[key] = match.group(1)
    addressee = re.search(r'"addressee"\s*:\s*(\d+)', buffer)
    if addressee:
        fields["addressee"] = int(addressee.group(1))
    if len(fields) < 2:
        return None
    return fields


@dataclass(frozen=True)
class Say:
    text: str


@dataclass(frozen=True)
class Meta:
    mode: PlanMode
    needs_deeper_creativity: bool


@dataclass(frozen=True)
class Step:
    step: PlanStep


@dataclass(frozen=True)
class Done:
    plan: DirectorPlan


PlanEvent = Say | Meta | Step | Done


def _extract_plan_meta(buffer: str) -> Meta | None:
    mode_match = re.search(r'"mode"\s*:\s*"(execute|pitch|amend|surprise)"', buffer)
    creativity_match = re.search(r'"needs_deeper_creativity"\s*:\s*(true|false)', buffer)
    if not mode_match or not creativity_match:
        return None
    return Meta(
        mode=mode_match.group(1),  # type: ignore[arg-type]
        needs_deeper_creativity=creativity_match.group(1) == "true",
    )


def _extract_plan_say(buffer: str) -> str | None:
    match = re.search(r'"say"\s*:\s*"((?:\\.|[^"\\])*)"', buffer)
    if not match:
        return None
    try:
        return json.loads(f'"{match.group(1)}"')
    except json.JSONDecodeError:
        return None


async def stream_plan(
    text: str,
    scene: SceneState | None,
    frame: SceneFrame | None = None,
    *,
    tier: Literal["fast", "strong"] = "fast",
    extra_context: str | None = None,
    adjustment: bool = False,
) -> AsyncIterator[PlanEvent]:
    """Stream one DirectorPlan, yielding fields as soon as they close."""
    selection = select_tier(frame, escalated=tier == "strong")
    if selection is None:
        return
    provider, model = selection
    if provider == "deepseek":
        # Compatibility tier: DeepSeek only supports the legacy intent stream,
        # so adapt it to a single execute plan rather than exposing a second
        # execution path to Producer.
        yield Meta(mode="execute", needs_deeper_creativity=False)
        async for intent in stream_intents(text, scene, frame):
            yield Step(PlanStep.model_validate(intent.model_dump()))
        yield Done(DirectorPlan(mode="execute"))
        return
    client = get_async_anthropic_client()
    if client is None:
        return

    buffer = ""
    consumed = 0
    yielded_say = False
    yielded_meta = False
    started = time.monotonic()
    try:
        system = build_plan_prompt(
            scene,
            _history_section(),
            tier=tier,
            amend_context=extra_context,
            adjustment=adjustment,
        )
        async with client.messages.stream(
            model=model,
            max_tokens=4096 if tier == "strong" else 1200,
            system=system,
            messages=[{"role": "user", "content": _build_user_content(text, frame)}],
        ) as stream:
            async for chunk in stream.text_stream:
                buffer += chunk
                if not yielded_say:
                    say = _extract_plan_say(buffer)
                    if say:
                        yielded_say = True
                        yield Say(say)
                if not yielded_meta:
                    meta = _extract_plan_meta(buffer)
                    if meta is not None:
                        yielded_meta = True
                        yield meta
                        if meta.needs_deeper_creativity:
                            return
                slices, consumed = extract_complete_array_items(buffer, consumed)
                for raw in slices:
                    try:
                        yield Step(PlanStep.model_validate_json(raw))
                    except Exception:
                        log.warning("skipping invalid streamed plan step: %s", raw[:160])
        try:
            yield Done(DirectorPlan.model_validate_json(buffer))
        except Exception:
            log.warning("plan stream ended without a valid DirectorPlan")
    except Exception:
        log.exception("stream_plan failed")
    finally:
        log.info("stream_plan %s (%s) finished in %.2fs", tier, model, time.monotonic() - started)


async def _stream_anthropic(
    model: str,
    text: str,
    scene: SceneState | None,
    frame: SceneFrame | None,
    on_partial: Callable[[dict[str, str | int]], Awaitable[None]] | None = None,
    hints: str | None = None,
) -> AsyncIterator[Intent]:
    client = get_async_anthropic_client()
    if client is None:
        return
    system = _system_prompt(scene, hints) + "\n\n" + _JSON_SCHEMA_HINT
    buffer = ""
    consumed = 0
    async with client.messages.stream(
        model=model,
        max_tokens=4096,
        system=system,
        messages=[{"role": "user", "content": _build_user_content(text, frame)}],
    ) as stream:
        async for chunk in stream.text_stream:
            buffer += chunk
            if on_partial:
                partial = extract_partial_preview_fields(buffer)
                if partial:
                    await on_partial(partial)
            slices, consumed = extract_complete_intents(buffer, consumed)
            for raw in slices:
                intent = _validate_intent_slice(raw)
                if intent is not None:
                    yield intent


async def _stream_deepseek(
    model: str,
    text: str,
    scene: SceneState | None,
    frame: SceneFrame | None,
    on_partial: Callable[[dict[str, str | int]], Awaitable[None]] | None = None,
    hints: str | None = None,
) -> AsyncIterator[Intent]:
    if frame is not None:
        log.warning("DeepSeek path does not support vision; skipping frame attachment")
    client = get_async_deepseek_client()
    if client is None:
        return
    system = _system_prompt(scene, hints) + "\n\n" + _JSON_SCHEMA_HINT
    buffer = ""
    consumed = 0
    response = await client.chat.completions.create(
        model=model,
        max_tokens=4096,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": text},
        ],
        stream=True,
    )
    async for chunk in response:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta.content
        if not delta:
            continue
        buffer += delta
        if on_partial:
            partial = extract_partial_preview_fields(buffer)
            if partial:
                await on_partial(partial)
        slices, consumed = extract_complete_intents(buffer, consumed)
        for raw in slices:
            intent = _validate_intent_slice(raw)
            if intent is not None:
                yield intent


async def stream_intents(
    text: str,
    scene: SceneState | None,
    frame: SceneFrame | None = None,
    on_partial: Callable[[dict[str, str | int]], Awaitable[None]] | None = None,
    hints: str | None = None,
) -> AsyncIterator[Intent]:
    """Stream intents as the LLM completes each one, instead of waiting for the
    full response. Callers should treat zero yielded intents (including on any
    provider error, which is logged and swallowed here) as a signal to fall
    back to :func:`parse_intents` / the rule parser exactly as before.
    """
    provider = select_provider(frame)
    if provider is None:
        return
    model = _model_for(provider)
    started = time.monotonic()
    count = 0
    try:
        stream_fn = _stream_deepseek if provider == "deepseek" else _stream_anthropic
        async for intent in stream_fn(model, text, scene, frame, on_partial, hints):
            count += 1
            yield intent
    except ImportError:
        log.warning("LLM SDK not installed; using fallback parser")
        return
    except Exception:
        log.exception("stream_intents failed; falling back to rule parser")
        return
    finally:
        log.info(
            "stream_intents via %s (%s) yielded %d intent(s) in %.2fs",
            provider,
            model,
            count,
            time.monotonic() - started,
        )
