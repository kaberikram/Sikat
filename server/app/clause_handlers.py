"""Ordered clause handlers for the fallback parser."""
from __future__ import annotations

import math
import re
from collections.abc import Callable

from . import session_context
from .fx_vocab import FX_PARAM_KEYS, FX_WORDS, PRIMARY_FX_PARAM
from .scene_context import describe_fallback_message
from .schema import FxSetting, Intent, SceneState, Transition

COLOR_WORDS: dict[str, str] = {
    "red": "#ff3b30",
    "blue": "#0a84ff",
    "green": "#30d158",
    "yellow": "#ffd60a",
    "orange": "#ff9f0a",
    "purple": "#bf5af2",
    "pink": "#ff2d55",
    "white": "#ffffff",
    "black": "#111111",
    "cyan": "#00ffff",
    "magenta": "#ff00ff",
    "gray": "#8e8e93",
    "grey": "#8e8e93",
    "gold": "#ffd700",
    "teal": "#64d2ff",
    "brown": "#a2845e",
}

PRIMITIVE_WORDS: dict[str, str] = {
    "box": "box",
    "cube": "box",
    "crate": "box",
    "sphere": "sphere",
    "ball": "sphere",
    "orb": "sphere",
    "cone": "cone",
    "cylinder": "cylinder",
    "tube": "cylinder",
    "torus": "torus",
    "donut": "torus",
    "ring": "torus",
    "plane": "plane",
    "floor": "plane",
    "ground": "plane",
    "text": "text",
    "tag": "text",
    "sign": "text",
    "label": "text",
}

MOOD_WORDS: dict[str, str] = {
    "noir": "noir",
    "moody": "noir",
    "film noir": "noir",
    "sunset": "sunset",
    "golden hour": "sunset",
    "studio": "studio",
    "neutral": "studio",
    "default": "studio",
    "neon": "neon",
    "cyberpunk": "neon",
}

DIRECTIONS: dict[str, tuple[float, float, float]] = {
    "up": (0, 1, 0),
    "down": (0, -1, 0),
    "left": (-1, 0, 0),
    "right": (1, 0, 0),
    "forward": (0, 0, -1),
    "forwards": (0, 0, -1),
    "back": (0, 0, 1),
    "backward": (0, 0, 1),
    "backwards": (0, 0, 1),
}

_NUM = r"(-?\d+(?:\.\d+)?)"
Handler = Callable[[str, SceneState | None, Transition | None], Intent | None]

# Pronouns that refer back to the last object the director touched.
_PRONOUN = re.compile(r"\b(it|that|this one|this|them|those)\b")
# A bare relative correction: an optional verb + a direction + optional softener.
_AMEND_DIR = re.compile(
    r"(?:go|move|nudge|shift|pull|push|bring)?\s*"
    r"(up|down|left|right|back|backward|backwards|forward|forwards)"
    r"\s*(a bit|a little|slightly|more)?"
)
# "again" / "a bit more" with no direction -> repeat the last transform verbatim.
_AMEND_REPEAT = re.compile(r"(again|a bit more|more|same again|do it again)")

_NUMBER_WORDS: dict[str, int] = {"one": 1, "two": 2, "three": 3, "four": 4}
_PERFORMER_ADDR = re.compile(
    r"^(?:agent|performer|number)\s+(one|two|three|four|\d+)\s*[,:.\s]+(.*)$",
    re.I,
)
_BARE_PERFORMER = re.compile(
    r"^(?:agent|performer|number)\s+(one|two|three|four|\d+)\s*\.?$",
    re.I,
)
_ASSIGN_VERB = re.compile(
    r"\b(you'?re on|you take|you handle|take the|handle the)\b",
    re.I,
)


def _performer_num(token: str) -> int | None:
    token = token.lower()
    if token.isdigit():
        n = int(token)
        return n if 1 <= n <= 4 else None
    return _NUMBER_WORDS.get(token)


def _resolve_performer_clause(
    clause: str, scene: SceneState | None
) -> tuple[Intent | None, str | None, int | None]:
    bare = _BARE_PERFORMER.fullmatch(clause.strip())
    if bare:
        n = _performer_num(bare.group(1))
        if n:
            session_context.note_addressee(n)
        return None, None, n

    m = _PERFORMER_ADDR.match(clause.strip())
    if not m:
        return None, clause, None

    n = _performer_num(m.group(1))
    if not n:
        return None, clause, None
    rest = m.group(2).strip()
    session_context.note_addressee(n)

    if _ASSIGN_VERB.search(rest):
        target = _find_target(rest, scene) or session_context.last_target()
        if not target:
            return None, None, n
        return Intent(action="assign", addressee=n, target=target, role=target), None, n

    return None, rest, n


def _extract_transition(clause: str) -> tuple[Transition | None, str]:
    m = re.search(
        rf"\b(?:over|across|for|in|taking)\s+{_NUM}\s*(?:s\b|sec\b|secs\b|seconds?\b)",
        clause,
    )
    if not m:
        return None, clause
    duration = float(m.group(1))
    rest = (clause[: m.start()] + " " + clause[m.end() :]).strip()
    return Transition(durationSec=duration), rest


def _find_color(clause: str) -> str | None:
    for word, hex_color in COLOR_WORDS.items():
        if re.search(rf"\b{word}\b", clause):
            return hex_color
    m = re.search(r"#[0-9a-fA-F]{6}\b", clause)
    return m.group(0) if m else None


def _find_scene_target(clause: str, scene: SceneState | None) -> str | None:
    if scene is None:
        return None
    for obj in scene.objects:
        if obj.name.lower() in clause:
            return obj.name
    clause_words = set(re.findall(r"[a-z]+", clause))
    for obj in scene.objects:
        name_tokens = {t for t in re.split(r"[^a-z]+", obj.name.lower()) if len(t) >= 3}
        for word in clause_words:
            if word in name_tokens:
                return obj.name
            if word in PRIMITIVE_WORDS and PRIMITIVE_WORDS[word] in name_tokens:
                return obj.name
    return None


def _find_target(clause: str, scene: SceneState | None) -> str | None:
    resolved = _find_scene_target(clause, scene)
    if resolved:
        return resolved
    for word in PRIMITIVE_WORDS:
        if re.search(rf"\b{word}\b", clause):
            return word
    # Pronoun ("move it up") -> whatever the director last addressed.
    if _PRONOUN.search(clause):
        return session_context.last_target()
    return None


def _find_vec3_after(clause: str, anchor: str) -> tuple[float, float, float] | None:
    m = re.search(rf"\b{anchor}\s+{_NUM}[,\s]+{_NUM}[,\s]+{_NUM}", clause)
    if not m:
        return None
    return (float(m.group(1)), float(m.group(2)), float(m.group(3)))


def _parse_playback(
    clause: str, _scene: SceneState | None, _transition: Transition | None
) -> Intent | None:
    if re.search(r"(?:^|\b)(?:and\s+)?action(?:\s|$)", clause):
        return Intent(action="playback", playback_action="record")
    if re.search(r"camera'?s?\s+(?:is\s+)?rolling", clause):
        return Intent(action="playback", playback_action="record")
    if re.search(r"start\s+recording", clause):
        return Intent(action="playback", playback_action="record")
    if re.search(r"we'?re\s+rolling", clause):
        return Intent(action="playback", playback_action="record")
    if re.search(r"roll\s+(?:camera|sound|it)\b", clause):
        return Intent(action="playback", playback_action="record")
    if re.search(r"\bcut\b", clause) or re.search(r"that'?s\s+a\s+cut", clause):
        return Intent(action="playback", playback_action="cut")
    if re.search(r"stop\s+recording", clause):
        return Intent(action="playback", playback_action="cut")
    if re.fullmatch(r"(play|go|roll(?:ing)?(?: it)?)", clause):
        return Intent(action="playback", playback_action="play")
    if re.fullmatch(r"(pause|stop|freeze|hold)", clause):
        return Intent(action="playback", playback_action="pause")
    if re.fullmatch(r"(back to one|top of (the )?scene|back to the top of the scene)", clause):
        return Intent(
            action="playback",
            playback_action="seek",
            seek_time=0,
            playback_pause_after_seek=True,
        )
    m = re.search(rf"\b(?:go to|seek(?: to)?|jump to)\s+{_NUM}", clause)
    if m:
        return Intent(action="playback", playback_action="seek", seek_time=float(m.group(1)))
    if re.fullmatch(r"(rewind|go to start|from the top|back to the top)", clause):
        return Intent(action="playback", playback_action="seek", seek_time=0)
    return None


def _parse_mood(
    clause: str, _scene: SceneState | None, _transition: Transition | None
) -> Intent | None:
    for word, mood in MOOD_WORDS.items():
        if re.search(rf"\b{word}\b", clause) and (
            clause == word
            or re.search(
                r"\b(mood|scene|vibe|look|feel|feels?|lighting|atmosphere|make it)\b", clause
            )
        ):
            return Intent(action="set_scene", mood=mood)
    return None


def _parse_fx(
    clause: str, _scene: SceneState | None, _transition: Transition | None
) -> Intent | None:
    for word, section in FX_WORDS.items():
        if word in clause:
            settings: list[FxSetting] = []
            enabled: bool | None = None
            if re.search(r"\b(off|disable|remove|kill|no more|without)\b", clause):
                enabled = False
            elif re.search(r"\b(on|enable|add|activate|show|start|turn on|with)\b", clause):
                enabled = True
            primary, high, low = PRIMARY_FX_PARAM[section]
            if re.search(r"\b(more|boost|increase|crank|heavy|stronger)\b", clause):
                enabled = True
                settings.append(FxSetting(key=primary, value=high))
            elif re.search(r"\b(less|reduce|decrease|subtle|lighter|weaker)\b", clause):
                enabled = True
                settings.append(FxSetting(key=primary, value=low))
            for spoken, key in FX_PARAM_KEYS[section].items():
                m = re.search(rf"\b{spoken}\s*(?:to|at|=)\s*{_NUM}", clause)
                if m:
                    enabled = True if enabled is None else enabled
                    settings.append(FxSetting(key=key, value=float(m.group(1))))
            if enabled is None and not settings:
                enabled = True
            return Intent(
                action="update_fx",
                section=section,  # type: ignore[arg-type]
                fx_enabled=enabled,
                fx_set=settings or None,
            )
    return None


def _parse_lights(
    clause: str, _scene: SceneState | None, _transition: Transition | None
) -> Intent | None:
    if not re.search(
        r"\b(light|lights|lighting|dim|dimmer|dark|darker|bright|brighter|brighten|background|backdrop)\b",
        clause,
    ):
        return None
    intent = Intent(action="update_lights")
    color = _find_color(clause)
    if re.search(r"\b(background|backdrop)\b", clause):
        intent.background = color or "#111111"
        return intent
    touched = False
    if re.search(r"\b(off|kill)\b", clause):
        intent.ambient_intensity, intent.key_intensity = 0.05, 0.0
        touched = True
    elif re.search(r"\b(dim|dimmer|dark|darker|lower|down|less)\b", clause):
        intent.ambient_intensity, intent.key_intensity = 0.3, 0.7
        touched = True
    elif re.search(r"\b(bright|brighter|brighten|up|more|full)\b", clause):
        intent.ambient_intensity, intent.key_intensity = 1.0, 2.2
        touched = True
    if re.search(r"\bwarm(er)?\b", clause):
        intent.ambient_color, intent.key_color = "#ffd9a8", "#ffb066"
        touched = True
    elif re.search(r"\b(cool(er)?|cold)\b", clause):
        intent.ambient_color, intent.key_color = "#a8c8ff", "#7fb4ff"
        touched = True
    if color:
        intent.key_color = color
        touched = True
    m = re.search(rf"\bintensity\s*(?:to|at|=)?\s*{_NUM}", clause)
    if m:
        intent.key_intensity = float(m.group(1))
        touched = True
    return intent if touched else None


def _parse_camera(
    clause: str, scene: SceneState | None, transition: Transition | None
) -> Intent | None:
    if not (
        re.search(r"\b(camera|cam|viewfinder|shot|zoom|dolly)\b", clause)
        or re.search(r"\b(push in|pull back|pull out)\b", clause)
    ):
        return None
    cur_fov = scene.virtualCamera.fov if scene else 50.0
    cam_transition = transition or Transition(durationSec=1.5)
    m = re.search(rf"\bfov\s*(?:to|at|=)?\s*{_NUM}", clause)
    if m:
        return Intent(action="move_camera", fov=float(m.group(1)), transition=cam_transition)
    if re.search(r"\b(zoom in|push in|closer|tighter)\b", clause):
        return Intent(
            action="move_camera", fov=max(15.0, cur_fov - 15.0), transition=cam_transition
        )
    if re.search(r"\b(zoom out|pull back|pull out|wider)\b", clause):
        return Intent(
            action="move_camera", fov=min(110.0, cur_fov + 15.0), transition=cam_transition
        )
    if re.search(r"\b(?:look at|point at|aim at)\s+(?:the\s+)?stage\b", clause):
        return Intent(action="move_camera", look_at="STAGE", transition=cam_transition)
    pos = _find_vec3_after(clause, "to")
    m = re.search(r"\b(?:look at|point at|aim at)\s+(?:the\s+)?([a-z0-9_ ]+)", clause)
    look_at = _find_target(m.group(1), scene) if m else None
    if pos or look_at:
        return Intent(
            action="move_camera", position=pos, look_at=look_at, transition=cam_transition
        )
    return None


def _parse_animate(
    clause: str, scene: SceneState | None, transition: Transition | None
) -> Intent | None:
    if not re.search(r"\b(turnaround|turn around|360|spin around|orbit|bounce)\b", clause):
        return None
    preset = "turnaround"
    if "orbit" in clause:
        preset = "orbit"
    elif "bounce" in clause:
        preset = "bounce"
    target = _find_target(clause, scene)
    if not target:
        return None
    return Intent(action="animate", preset=preset, target=target, transition=transition)  # type: ignore[arg-type]


def _parse_remove(
    clause: str, scene: SceneState | None, _transition: Transition | None
) -> Intent | None:
    if not re.search(r"\b(remove|delete|destroy|get rid of)\b", clause):
        return None
    target = _find_target(clause, scene)
    if not target:
        return None
    return Intent(action="remove", target=target)


def _parse_material(
    clause: str, scene: SceneState | None, _transition: Transition | None
) -> Intent | None:
    if not re.search(r"\b(paint|colou?r|tint|make|turn)\b", clause):
        return None
    color = _find_color(clause)
    existing = _find_scene_target(clause, scene)
    if not (color and existing):
        return None
    intent = Intent(action="set_material", target=existing, color=color)
    if re.search(r"\b(glow|glowing|emissive|neon)\b", clause):
        intent.emissive = color
        intent.emissive_intensity = 1.5
    return intent


def _parse_spawn(
    clause: str, _scene: SceneState | None, _transition: Transition | None
) -> Intent | None:
    if not re.search(r"\b(add|spawn|create|make|drop|place|give me)\b", clause):
        return None
    for word, primitive in PRIMITIVE_WORDS.items():
        if re.search(rf"\b{word}\b", clause):
            name_m = re.search(r"\b(?:called|named)\s+([a-z0-9_]+)", clause)
            text_m = re.search(r"(?:\"([^\"]+)\"|'([^']+)'|\bsaying\s+(.+)$)", clause)
            text_value = None
            if text_m:
                text_value = next(g for g in text_m.groups() if g)
            return Intent(
                action="spawn",
                primitive=primitive,  # type: ignore[arg-type]
                color=_find_color(clause),
                name=name_m.group(1).upper() if name_m else None,
                text=text_value,
                position=_find_vec3_after(clause, "at"),
            )
    return None


def _parse_scale(
    clause: str, scene: SceneState | None, transition: Transition | None
) -> Intent | None:
    if not re.search(r"\b(scale|grow|shrink|bigger|smaller|larger|double|halve|half)\b", clause):
        return None
    target = _find_target(clause, scene)
    if not target:
        return None
    m = re.search(rf"\b(?:by|to)\s+{_NUM}", clause)
    absolute = bool(re.search(rf"\bto\s+{_NUM}", clause))
    if m:
        factor = float(m.group(1))
    elif re.search(r"\b(double|twice)\b", clause):
        factor = 2.0
    elif re.search(r"\b(halve|half)\b", clause):
        factor = 0.5
    elif re.search(r"\b(shrink|smaller)\b", clause):
        factor = 0.667
    else:
        factor = 1.5
    return Intent(
        action="transform",
        target=target,
        scale=(factor, factor, factor),
        mode="absolute" if absolute else "relative",
        transition=transition,
    )


def _parse_rotate(
    clause: str, scene: SceneState | None, transition: Transition | None
) -> Intent | None:
    if not re.search(r"\b(rotate|spin|turn|tilt)\b", clause):
        return None
    target = _find_target(clause, scene)
    if not target:
        return None
    m = re.search(rf"{_NUM}\s*(?:deg|degrees?|°)", clause)
    radians = math.radians(float(m.group(1))) if m else math.pi / 4
    axis = 1
    if re.search(r"\b(x|pitch|tilt)\b", clause):
        axis = 0
    elif re.search(r"\b(z|roll)\b", clause):
        axis = 2
    rotation = [0.0, 0.0, 0.0]
    rotation[axis] = radians
    return Intent(
        action="transform",
        target=target,
        rotation=tuple(rotation),  # type: ignore[arg-type]
        mode="relative",
        transition=transition,
    )


def _parse_amendment(
    clause: str, scene: SceneState | None, transition: Transition | None
) -> Intent | None:
    """Small live corrections with no named target, e.g. 'go back a bit'.

    Resolves against the last object the director touched (this command or a
    recent one). Kept ahead of _parse_move so a bare direction becomes a nudge
    on the running target instead of being dropped for lack of a target.
    """
    clause = clause.strip()
    # A named/typed target means this is an ordinary move, not an amendment.
    if _find_scene_target(clause, scene):
        return None
    if any(re.search(rf"\b{word}\b", clause) for word in PRIMITIVE_WORDS):
        return None
    target = session_context.last_target()
    if not target:
        return None
    if _AMEND_REPEAT.fullmatch(clause):
        last = session_context.last_transform()
        return last.model_copy(deep=True) if last is not None else None
    match = _AMEND_DIR.fullmatch(clause)
    if not match:
        return None
    direction = DIRECTIONS[match.group(1)]
    qualifier = match.group(2)
    if qualifier in ("a bit", "a little", "slightly"):
        amount = 0.25
    elif qualifier == "more":
        amount = 1.0
    else:
        amount = 0.5
    return Intent(
        action="transform",
        target=target,
        position=(direction[0] * amount, direction[1] * amount, direction[2] * amount),
        mode="relative",
        transition=transition,
    )


def _parse_move(
    clause: str, scene: SceneState | None, transition: Transition | None
) -> Intent | None:
    if not re.search(r"\b(move|shift|slide|raise|lower|lift|nudge|bring)\b", clause):
        return None
    target = _find_target(clause, scene)
    if not target:
        return None
    absolute = _find_vec3_after(clause, "to")
    if absolute:
        return Intent(
            action="transform",
            target=target,
            position=absolute,
            mode="absolute",
            transition=transition,
        )
    direction = None
    if re.search(r"\b(raise|lift)\b", clause):
        direction = DIRECTIONS["up"]
    elif re.search(r"\blower\b", clause):
        direction = DIRECTIONS["down"]
    else:
        for word, vec in DIRECTIONS.items():
            if re.search(rf"\b{word}\b", clause):
                direction = vec
                break
    if not direction:
        return None
    m = re.search(rf"\b(?:by\s+)?{_NUM}\b", clause)
    amount = float(m.group(1)) if m else 1.0
    return Intent(
        action="transform",
        target=target,
        position=(direction[0] * amount, direction[1] * amount, direction[2] * amount),
        mode="relative",
        transition=transition,
    )


def _parse_describe(
    clause: str, scene: SceneState | None, _transition: Transition | None
) -> Intent | None:
    topic: str | None = None
    target: str | None = None

    if re.search(r"\bprint the take\b", clause):
        topic = "scene"
    elif re.search(r"\bwhat'?s happening\b", clause):
        topic = "scene"
    elif re.search(r"\bdescribe the (shot|scene)\b", clause):
        topic = "scene"
    elif re.search(r"\bhow'?s the animation\b", clause) or re.search(
        r"\bhow does (the )?animation\b", clause
    ):
        topic = "animation"
    elif m := re.search(r"how'?s the bounce on (?:the )?([a-z0-9_ ]+)", clause):
        topic = "animation"
        target = _find_target(m.group(1), scene)
    elif re.search(r"\bhow'?s the (lighting|lights)\b", clause):
        topic = "lighting"
    elif re.search(r"\bhow'?s the (fx|effects|viewfinder)\b", clause):
        topic = "fx"
    elif re.search(r"\bhow'?s the (camera|shot|frame)\b", clause):
        topic = "camera"
    elif re.search(r"\b(look at|check) (the )?(shot|frame|viewfinder)\b", clause):
        topic = "scene"
    elif re.search(r"\bhow does (this|it) look\b", clause):
        topic = "scene"
    elif re.search(r"\btoo (dark|bright|moody|flat)\b", clause):
        if re.search(r"\b(fix|warm|cool|dim|brighten|lighter|darker|adjust)\b", clause):
            return None
        topic = "scene"
    else:
        return None

    message = describe_fallback_message(clause, scene, topic, target)
    return Intent(
        action="describe",
        describe_topic=topic,  # type: ignore[arg-type]
        describe_message=message,
        target=target,
    )


HANDLERS: list[Handler] = [
    _parse_playback,
    _parse_describe,
    _parse_mood,
    _parse_fx,
    _parse_lights,
    _parse_camera,
    _parse_animate,
    _parse_remove,
    _parse_material,
    _parse_spawn,
    _parse_scale,
    _parse_rotate,
    _parse_amendment,
    _parse_move,
]


def parse_clause(clause: str, scene: SceneState | None) -> Intent | None:
    clause = clause.strip().lower()
    if not clause:
        return None

    early, work, addressee = _resolve_performer_clause(clause, scene)
    if early is not None:
        return early
    if work is None:
        return None

    transition, work = _extract_transition(work)
    for handler in HANDLERS:
        intent = handler(work, scene, transition)
        if intent is not None:
            addr = addressee or session_context.pending_addressee()
            if addr is not None:
                intent = intent.model_copy(update={"addressee": addr})
            return intent
    return None
