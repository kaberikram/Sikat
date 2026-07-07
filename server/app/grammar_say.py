"""Parametric set-radio lines for grammar-owned intents (no LLM)."""
from __future__ import annotations

from .schema import Intent

_COLOR_WORDS: dict[str, str] = {
    "#ff3b30": "red",
    "#ff0000": "red",
    "#0a84ff": "blue",
    "#3366ff": "blue",
    "#0076ff": "blue",
    "#34c759": "green",
    "#ffcc00": "yellow",
    "#ffffff": "white",
    "#000000": "black",
}


def _color_word(color: str | None) -> str | None:
    if not color:
        return None
    lower = color.lower()
    return _COLOR_WORDS.get(lower)


def _truncate_words(text: str, max_words: int = 8) -> str:
    words = text.split()
    if len(words) <= max_words:
        return text
    return " ".join(words[:max_words])


def radio_line(intent: Intent) -> str:
    """≤8 words, present-tense set radio for a parsed intent."""
    action = intent.action

    if action == "spawn":
        prim = (intent.primitive or "box").lower()
        color = _color_word(intent.color)
        if color:
            return _truncate_words(f"{prim} in, {color}, dead center")
        return _truncate_words(f"{prim} in, dead center")

    if action == "remove":
        target = intent.target or "it"
        return _truncate_words(f"clearing {target}")

    if action == "transform":
        target = intent.target or "it"
        if intent.mode == "relative":
            return _truncate_words(f"nudging {target}")
        return _truncate_words(f"moving {target}")

    if action == "animate":
        target = intent.target or "it"
        motion = intent.motion or intent.preset or "motion"
        return _truncate_words(f"{motion} on {target}")

    if action == "move_camera":
        if intent.look_at:
            return _truncate_words(f"framing {intent.look_at}")
        return "reframing the shot"

    if action == "update_lights":
        if intent.key_intensity is not None:
            if intent.key_intensity >= 1.0:
                return "warming the key"
            return "dimming the key"
        if intent.ambient_intensity is not None:
            if intent.ambient_intensity >= 0.5:
                return "opening ambient"
            return "dimming ambient"
        return "relighting the set"

    if action == "set_material":
        target = intent.target or "it"
        return _truncate_words(f"painting {target}")

    if action == "update_fx":
        section = (intent.section or "fx").lower()
        if intent.fx_enabled is False:
            return _truncate_words(f"cutting {section}")
        return _truncate_words(f"{section} up on the lens")

    if action == "playback":
        act = intent.playback_action or "play"
        mapping = {
            "play": "rolling",
            "pause": "hold",
            "cut": "that's a cut",
            "record": "rolling take",
            "seek": "back to one",
            "loop_on": "looping it",
            "loop_off": "loop off",
        }
        return mapping.get(act, "on transport")

    if action == "set_scene":
        mood = intent.mood or "scene"
        return _truncate_words(f"{mood} mood, locking in")

    if action == "assign":
        who = f"Agent{intent.addressee}" if intent.addressee else "performer"
        target = intent.target or "target"
        return _truncate_words(f"{who} on {target}")

    return "on it"


def intent_with_radio(intent: Intent) -> Intent:
    """Return intent with grammar radio line when say is absent."""
    if intent.say or intent.action in ("describe", "suggest", "clarify"):
        return intent
    return intent.model_copy(update={"say": radio_line(intent)})
