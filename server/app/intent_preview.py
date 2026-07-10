"""Fast intent preview — acknowledge target + agent before full LLM parse."""
from __future__ import annotations

import re

from . import performers
from .director_vocab import normalize_clause
from .fallback_parser import parse_one_clause, split_clauses
from .schema import Intent, SceneState

_AGENT_RE = re.compile(r"\bagent\s*([1-4])\b", re.I)
_ANIMATE_RE = re.compile(
    r"\b(animate|animating|animation|bounce|bounc(?:e|ing)|float|orbit|spin|wander)\b",
    re.I,
)
_MOTION_WORDS = (
    "arc", "bounce", "float", "drop", "spin", "orbit", "wander", "pulse",
    "sway", "drift", "figure8", "zigzag", "spiral", "launch", "swing", "shake",
)


def _agent_for_intent(intent: Intent | None, text: str) -> str:
    if intent and intent.addressee:
        return f"Agent{intent.addressee}"
    m = _AGENT_RE.search(text)
    if m:
        return f"Agent{m.group(1)}"
    if intent:
        action_agents = {
            "update_lights": "LightingTech",
            "set_material": "LightingTech",
            "update_fx": "VFXOperator",
            "playback": "Producer",
            "set_scene": "Producer",
        }
        return action_agents.get(intent.action, "AssetAnimator")
    # No grammar hit yet — still steer the likely specialist from verbs.
    if _ANIMATE_RE.search(text):
        return "AssetAnimator"
    if re.search(r"\b(light|lights|dim|key|fill|rim)\b", text, re.I):
        return "LightingTech"
    if re.search(r"\b(bloom|glitch|fx|pixelate|dither)\b", text, re.I):
        return "VFXOperator"
    return "Producer"


def _colloquial_target(text: str, scene: SceneState) -> str | None:
    """Map director slang (ball → sphere) the same way clause_handlers does."""
    words = set(re.findall(r"[a-z]+", text.lower()))
    if "ball" in words or "balls" in words:
        for obj in scene.objects:
            name_lower = obj.name.lower()
            if "sphere" in name_lower or "ball" in name_lower or "orb" in name_lower:
                return obj.name
    for word, primitive in (("box", "box"), ("cube", "box"), ("cone", "cone"), ("cylinder", "cylinder")):
        if word not in words:
            continue
        for obj in scene.objects:
            if primitive in obj.name.lower():
                return obj.name
    return None


def _target_for_intent(intent: Intent | None, text: str, scene: SceneState | None) -> str | None:
    if intent and intent.target:
        return intent.target
    if intent and intent.addressee:
        assignment = performers.get(intent.addressee)
        if assignment:
            return assignment.target
    if scene:
        lower = text.lower()
        best: tuple[str, int] | None = None
        for obj in scene.objects:
            name = obj.name.lower()
            if len(name) >= 2 and name in lower:
                if best is None or len(name) > best[1]:
                    best = (obj.name, len(name))
        if best:
            return best[0]
        colloquial = _colloquial_target(text, scene)
        if colloquial:
            return colloquial
    return None


def _motion_hint(intent: Intent | None, text: str) -> str | None:
    if intent and (intent.motion or intent.preset):
        return intent.motion or intent.preset
    lower = text.lower()
    for word in _MOTION_WORDS:
        if word in lower:
            return word
    return None


def _preview_note(
    agent: str,
    target: str | None,
    action: str | None,
    motion: str | None,
) -> str:
    if target and motion:
        return f"on {target}, {motion}"
    if target:
        return f"heading to {target}"
    if motion:
        return f"{motion} incoming"
    if action == "update_lights":
        return "checking the light"
    if action == "update_fx":
        return "on the comp"
    if action == "playback":
        return "on transport"
    if action == "animate" or agent == "AssetAnimator":
        return "animating"
    if agent.startswith("Agent"):
        return f"{agent.lower()} on it"
    return "on it"


def build_intent_preview(
    text: str,
    scene: SceneState | None,
    command_id: str,
) -> dict | None:
    """Build a fast preview dict, or None when nothing useful can be inferred."""
    clauses = split_clauses(text)
    clause = normalize_clause(clauses[0] if clauses else text)
    intent = parse_one_clause(clause, scene)

    agent = _agent_for_intent(intent, text)
    target = _target_for_intent(intent, text, scene)
    motion = _motion_hint(intent, text)
    action = intent.action if intent else None
    if action is None and _ANIMATE_RE.search(text):
        action = "animate"

    if not target and not motion and not action and not _AGENT_RE.search(text):
        return None

    confidence = "grammar" if intent is not None else "guess"
    note = intent.say if intent and intent.say else _preview_note(agent, target, action, motion)

    return {
        "type": "intent_preview",
        "commandId": command_id,
        "agent": agent,
        "target": target,
        "action": action,
        "motion": motion,
        "note": note[:80],
        "confidence": confidence,
    }
