"""Ordered clause handlers for the fallback parser."""
from __future__ import annotations

import math
import re
from collections.abc import Callable

from . import session_context
from .converse import converse_intent, is_open_speech
from .fx_vocab import FX_PARAM_KEYS, FX_WORDS, PRIMARY_FX_PARAM
from .motion_vocab import extract_motion, extract_motion_params
from .scene_context import describe_fallback_message
from .schema import FxSetting, Intent, SceneState, Transition
from .target_resolution import ambiguous_options, is_ambiguous, rank_targets

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
    "silver": "#c0c0c0",
    "navy": "#001f3f",
    "lime": "#32cd32",
    "coral": "#ff7f50",
    "violet": "#8a2be2",
    "cream": "#fffdd0",
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
    "sneaker": "sneaker",
    "shoe": "sneaker",
    "trainer": "sneaker",
    "word": "text",
    "title": "text",
    "headline": "text",
    "block": "box",
    "disc": "cylinder",
    "pill": "cylinder",
    "wheel": "torus",
    "product": "sphere",
    "hero": "sphere",
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
    "dramatic": "noir",
    "cinematic": "noir",
    "dark": "noir",
    "dreamy": "sunset",
    "clean": "studio",
    "minimal": "studio",
    "vibrant": "neon",
    "bright": "studio",
    "shine": "shine",
    "showcase": "shine",
    "product showcase": "shine",
    "hero shot": "shine",
    "product shot": "shine",
}

# Words whose bare mood mapping (bright->studio, dark->noir) conflicts with
# _parse_lights' own vocabulary — skip the mood claim when the clause is
# complaining about brightness/darkness rather than naming an aesthetic.
_MOOD_LIGHT_WORDS = ("bright", "dark")
_MOOD_TRIGGER = re.compile(
    r"\b(mood|scene|vibe|look|feel|feels?|lighting|atmosphere|make it|style|showcase|shot)\b"
)
_COMPLAINT_FRAME = re.compile(r"\b(too|way too|much too|so)\b")

# FX complaint framing: "too much bloom" / "way too heavy" / "tone it down" —
# always means reduce, regardless of which intensity word (heavy/strong) is used.
_FX_COMPLAINT = re.compile(
    r"\b(too much|way too much|far too much|much too much|too heavy|too strong|"
    r"excessive|overdone|tone (?:it )?down|dial (?:it )?back)\b"
)
_DEGREE_MILD = re.compile(r"\b(a bit|a little|slightly|somewhat)\b")
_DEGREE_STRONG = re.compile(r"\b(a lot|way too much|far too much|much too much|so much|way too)\b")


def _complaint_degree(clause: str) -> float:
    """Graded amount (0-1) for a complaint/adjustment, reusing the same small
    qualifier vocabulary _parse_amendment uses for transform nudges."""
    if _DEGREE_STRONG.search(clause):
        return 1.0
    if _DEGREE_MILD.search(clause):
        return 0.35
    return 0.75

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

# STT says "move it up two", not "move it up 2" — normalize word-numbers to
# digits, but only right after a magnitude preposition/direction so pronouns
# ("this one") and performer addresses ("agent two, …") are untouched.
_WORD_NUM_MAP = {
    "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
    "half": "0.5",
}
_WORD_NUM_RE = re.compile(
    # "back to one" is the film cue for reset-to-start — never a magnitude.
    r"(?<!back )\b(by|to|up|down|left|right|over)\s+"
    r"(one|two|three|four|five|six|seven|eight|nine|ten)\b"
)


def _normalize_word_numbers(clause: str) -> str:
    return _WORD_NUM_RE.sub(
        lambda m: f"{m.group(1)} {_WORD_NUM_MAP[m.group(2)]}", clause
    )


def _clause_without_target(clause: str, target: str | None) -> str:
    """Strip the resolved target's name so digits inside it (agent_2) never
    read as magnitudes ("move agent_2 up" must move by 1, not 2)."""
    if not target:
        return clause
    return clause.replace(target.lower(), " ")
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


def _extract_snap(clause: str) -> tuple[bool, str]:
    """Detect snap/instant keywords — motion should not tween."""
    m = re.search(r"\b(snap|instantly|instant)\b", clause)
    if not m:
        return False, clause
    rest = (clause[: m.start()] + " " + clause[m.end() :]).strip()
    return True, rest


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
    clause_words = set(re.findall(r"[a-z]+", clause))
    # Colloquial "ball" → any sphere-like object in the scene.
    if "ball" in clause_words or "balls" in clause_words:
        for obj in scene.objects:
            name_lower = obj.name.lower()
            if "sphere" in name_lower or "ball" in name_lower or "orb" in name_lower:
                return obj.name
    for obj in scene.objects:
        # Word-boundary match — a short name like "orb" must not fire on
        # unrelated words that merely contain it ("absorb").
        if re.search(rf"(?<![a-z0-9_]){re.escape(obj.name.lower())}(?![a-z0-9_])", clause):
            return obj.name
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


def _resolve_target_or_clarify(
    clause: str, scene: SceneState | None, question: str = "Which one"
) -> Intent | str | None:
    clarify = session_context.consume_clarify_target()
    if clarify:
        return clarify
    # Point + speak: a physical aim resolves deictics outright — never clarify.
    if _PRONOUN.search(clause):
        pointed = session_context.pointed_target()
        if pointed:
            return pointed
    ranked = rank_targets(clause, scene)
    if len(ranked) >= 2 and is_ambiguous(ranked):
        options = ambiguous_options(ranked)
        return Intent(
            action="clarify",
            clarify_question=f"{question} — {', '.join(options)}?",
            clarify_options=options,
        )
    if ranked:
        return ranked[0][0]
    return _find_target(clause, scene)


def _find_vec3_after(clause: str, anchor: str) -> tuple[float, float, float] | None:
    m = re.search(rf"\b{anchor}\s+{_NUM}[,\s]+{_NUM}[,\s]+{_NUM}", clause)
    if not m:
        return None
    return (float(m.group(1)), float(m.group(2)), float(m.group(3)))


def _target_has_motion(scene: SceneState, target_name: str) -> bool:
    needle = target_name.lower()
    for obj in scene.objects:
        name_lower = obj.name.lower()
        if name_lower == needle or re.search(
            rf"(?<![a-z0-9_]){re.escape(needle)}(?![a-z0-9_])", name_lower
        ):
            return bool(obj.keyframedProperties) or bool(obj.tracks)
    return False


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
    # "cut" only as a bare cue — "cut the bloom" / "haircut" must not end a take.
    if (
        re.search(r"^(?:ok(?:ay)?[,\s]+)?(?:and\s+|then\s+)?cut\s*[!.]*$", clause)
        or re.search(r"that'?s\s+a\s+(cut|wrap)", clause)
    ):
        return Intent(action="playback", playback_action="cut")
    if re.search(r"stop\s+recording", clause):
        return Intent(action="playback", playback_action="cut")
    if re.fullmatch(r"(loop|loop it|keep looping|on repeat)", clause):
        return Intent(action="playback", playback_action="loop_on")
    if re.fullmatch(r"(play once|no loop|don'?t loop|once only)", clause):
        return Intent(action="playback", playback_action="loop_off")
    if re.fullmatch(r"(restart|from the top)", clause):
        return Intent(action="playback", playback_action="seek", seek_time=0)
    if re.fullmatch(r"(play|go|roll(?:ing)?(?: it)?|continue|resume)", clause):
        return Intent(action="playback", playback_action="play")
    if re.fullmatch(r"(pause|stop|freeze|hold)", clause):
        freeze = False
        if _scene is not None and _scene.isPlaying:
            last = session_context.last_target()
            if last and _target_has_motion(_scene, last):
                freeze = True
        return Intent(
            action="playback",
            playback_action="pause",
            freeze_motion=freeze or None,
        )
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
    m = re.search(rf"\bat\s+{_NUM}\s*(?:s|sec|secs|seconds)\b", clause)
    if m:
        return Intent(action="playback", playback_action="seek", seek_time=float(m.group(1)))
    if re.fullmatch(r"(rewind|go to start|from the top|back to the top)", clause):
        return Intent(action="playback", playback_action="seek", seek_time=0)
    return None


def _parse_mood(
    clause: str, scene: SceneState | None, _transition: Transition | None
) -> Intent | None:
    for word, mood in MOOD_WORDS.items():
        if word in _MOOD_LIGHT_WORDS and _COMPLAINT_FRAME.search(clause):
            # "too bright" / "way too dark" is a lighting complaint, not a
            # mood pick — let _parse_lights handle it with correct polarity.
            continue
        if not re.search(rf"\b{word}\b", clause):
            continue
        multi_word = " " in word
        starts_with = clause.startswith(word) and len(clause) > len(word)
        if not (clause == word or multi_word or starts_with or _MOOD_TRIGGER.search(clause)):
            continue
        intent = Intent(action="set_scene", mood=mood)
        if mood == "shine":
            intent.target = _find_target(clause, scene)
        return intent
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
            if _FX_COMPLAINT.search(clause):
                # "too much bloom" / "tone down the bloom" — always a reduction,
                # even though the clause may also contain "heavy"/"strong".
                enabled = True
                degree = _complaint_degree(clause)
                settings.append(FxSetting(key=primary, value=round(high - (high - low) * degree, 3)))
            elif re.search(r"\b(more|boost|increase|crank|heavy|stronger)\b", clause):
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
    # A complaint flips the direction implied by the bare word: "too bright"
    # means dim it, "too dark" means brighten it — the opposite of what the
    # plain dim/bright branches below would do if they just matched the word.
    complaint_bright = bool(re.search(r"\b(too|way too|much too|so)\s+bright(?:er)?\b", clause))
    complaint_dark = bool(
        re.search(r"\b(too|way too|much too|so)\s+(dark(?:er)?|dim(?:mer)?)\b", clause)
    )
    if re.search(r"\b(off|kill)\b", clause):
        intent.ambient_intensity, intent.key_intensity = 0.05, 0.0
        touched = True
    elif complaint_bright:
        intent.ambient_intensity, intent.key_intensity = 0.3, 0.7
        touched = True
    elif complaint_dark:
        intent.ambient_intensity, intent.key_intensity = 1.0, 2.2
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
    if re.search(rf"{_NUM}\s*(?:deg|degrees?|°)", clause):
        return None
    if re.search(r"\b(add|spawn|create|text saying|saying)\b", clause):
        return None
    motion = extract_motion(clause)
    if not motion:
        return None
    resolved = _resolve_target_or_clarify(clause, scene, "Which object should I animate")
    if isinstance(resolved, Intent):
        return resolved
    target = resolved
    if not target:
        return None
    params = extract_motion_params(clause, motion, scene.stage.radius if scene else 1.0)
    repeat = bool(re.search(r"\b(loop|repeat|on repeat)\b", clause))
    preset = motion if motion in ("turnaround", "orbit", "bounce") else None
    return Intent(
        action="animate",
        preset=preset,  # type: ignore[arg-type]
        motion=motion,
        motion_params=params or None,
        animate_repeat=repeat,
        target=target,
        transition=transition,
    )


def _parse_remove(
    clause: str, scene: SceneState | None, _transition: Transition | None
) -> Intent | None:
    if not re.search(r"\b(remove|delete|destroy|hide|clear|lose)\b", clause):
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
    if not color:
        return None
    # Point + speak: a physical aim resolves "it/that" outright.
    existing: str | None = None
    if _PRONOUN.search(clause):
        existing = session_context.pointed_target()
    if not existing:
        ranked = rank_targets(clause, scene)
        if len(ranked) >= 2 and is_ambiguous(ranked):
            options = ambiguous_options(ranked)
            return Intent(
                action="clarify",
                clarify_question=f"Which one should I recolor — {', '.join(options)}?",
                clarify_options=options,
            )
        if ranked:
            existing = ranked[0][0]
        else:
            # _find_scene_target only matches real scene objects — unlike
            # _find_target, it never falls back to a bare primitive word
            # ("make a blue cone" must still fall through to _parse_spawn
            # when nothing named "cone" exists yet).
            existing = _find_scene_target(clause, scene)
    if not existing and _PRONOUN.search(clause):
        # Pronoun ("make it gold") -> whatever the director last addressed.
        existing = session_context.last_target()
    if not existing:
        return None
    intent = Intent(action="set_material", target=existing, color=color)
    if re.search(r"\b(glow|glowing|emissive|neon)\b", clause):
        intent.emissive = color
        intent.emissive_intensity = 1.5
    return intent


def _parse_spawn(
    clause: str, _scene: SceneState | None, _transition: Transition | None
) -> Intent | None:
    if not re.search(
        r"\b(add|spawn|create|make|drop|place|give me|insert|reveal|introduce|put)\b", clause
    ):
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


def _parse_squash(
    clause: str, scene: SceneState | None, transition: Transition | None
) -> Intent | None:
    if not re.search(
        r"\b(squash(?:ing|ed)?|squish(?:ing|ed)?|flatten(?:ing|ed)?|compress(?:ing|ed)?|pancake)\b",
        clause,
    ):
        return None
    target = _find_target(clause, scene)
    if not target:
        return None
    flat = 0.15 if re.search(r"\b(flat|pancake|paper thin)\b", clause) else 0.35
    return Intent(
        action="transform",
        target=target,
        scale=(1.0, flat, 1.0),
        mode="absolute",
        transition=transition,
    )


def _parse_scale(
    clause: str, scene: SceneState | None, transition: Transition | None
) -> Intent | None:
    if not re.search(
        r"\b(scale|grow|shrink|bigger|smaller|larger|double|halve|half|enlarge|expand|tiny|huge|massive|minimize)\b",
        clause,
    ):
        return None
    target = _find_target(clause, scene)
    if not target:
        return None
    clause_sans_target = _clause_without_target(clause, target)
    m = re.search(rf"\b(?:by|to)\s+{_NUM}", clause_sans_target)
    absolute = bool(re.search(rf"\bto\s+{_NUM}", clause_sans_target))
    if m:
        factor = float(m.group(1))
    elif re.search(r"\b(double|twice)\b", clause):
        factor = 2.0
    elif re.search(r"\b(halve|half)\b", clause):
        factor = 0.5
    elif re.search(r"\b(shrink|smaller|tiny|minimize)\b", clause):
        factor = 0.667
    elif re.search(r"\b(bigger|larger|huge|massive|enlarge|expand)\b", clause):
        factor = 1.5
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
    if not re.search(r"\b(rotate|tilt)\b", clause) and not (
        re.search(r"\b(spin|turn)\b", clause)
        and re.search(rf"{_NUM}\s*(?:deg|degrees?|°)", clause)
    ):
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
    if not re.search(r"\b(move|shift|slide|raise|lower|lift|nudge|bring|push|pull|send|position)\b", clause):
        return None
    resolved = _resolve_target_or_clarify(clause, scene, "Which object should I move")
    if isinstance(resolved, Intent):
        return resolved
    target = resolved
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
    m = re.search(rf"\b(?:by\s+)?{_NUM}\b", _clause_without_target(clause, target))
    amount = float(m.group(1)) if m else 1.0
    return Intent(
        action="transform",
        target=target,
        position=(direction[0] * amount, direction[1] * amount, direction[2] * amount),
        mode="relative",
        transition=transition,
    )


def _parse_converse(
    clause: str, _scene: SceneState | None, _transition: Transition | None
) -> Intent | None:
    """Greetings / thanks / presence → describe radio reply (keyless path)."""
    if not is_open_speech(clause):
        return None
    return converse_intent(clause)


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
        if re.search(
            r"\b(fix|warm|cool|dim|brighten|lighter|darker|adjust|reduce|decrease|less|"
            r"lower|tone down|dial back)\b",
            clause,
        ):
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
    _parse_converse,
    _parse_describe,
    _parse_mood,
    _parse_fx,
    _parse_lights,
    _parse_camera,
    _parse_animate,
    _parse_remove,
    _parse_material,
    _parse_spawn,
    _parse_squash,
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

    work = _normalize_word_numbers(work)
    transition, work = _extract_transition(work)
    snap, work = _extract_snap(work)
    if snap:
        transition = None
    for handler in HANDLERS:
        intent = handler(work, scene, transition)
        if intent is not None:
            addr = addressee or session_context.pending_addressee()
            updates: dict = {}
            if addr is not None:
                updates["addressee"] = addr
            if snap:
                updates["snap_motion"] = True
            if updates:
                intent = intent.model_copy(update=updates)
            return intent
    return None
