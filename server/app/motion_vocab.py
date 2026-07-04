"""Motion vocabulary + param extraction for the instant grammar path."""
from __future__ import annotations

import re

_NUM = r"(-?\d+(?:\.\d+)?)"
_WORD_NUM: dict[str, float] = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5}

# Longest / most specific phrases first.
MOTION_PHRASES: list[tuple[str, str]] = [
    ("bounce while moving", "bounce"),
    ("bounce on the path", "bounce"),
    ("bounce along the path", "bounce"),
    ("keep moving and bounce", "bounce"),
    ("add bounce", "bounce"),
    ("move around freely", "wander"),
    ("move freely", "wander"),
    ("move around", "wander"),
    ("free movement", "wander"),
    ("explore the stage", "wander"),
    ("roam the stage", "wander"),
    ("orbit the stage", "orbit"),
    ("circle the stage", "orbit"),
    ("figure 8", "figure8"),
    ("figure eight", "figure8"),
    ("turn around", "turnaround"),
    ("spin around", "turnaround"),
    ("high bounce", "bounce"),
    ("big bounce", "bounce"),
    ("three hops", "bounce"),
    ("two hops", "bounce"),
    ("soft landing", "drop"),
    ("floating", "float"),
    ("bouncing", "bounce"),
    ("swaying", "sway"),
    ("dropping", "drop"),
    ("falling", "drop"),
    ("rising", "rise"),
    ("pulsing", "pulse"),
    ("wobbling", "wobble"),
    ("shaking", "shake"),
    ("orbiting", "orbit"),
    ("spinning", "spin"),
    ("hover", "float"),
    ("float", "float"),
    ("drift", "drift"),
    ("drop", "drop"),
    ("fall", "drop"),
    ("rise", "rise"),
    ("pulse", "pulse"),
    ("breathe", "pulse"),
    ("sway", "sway"),
    ("wiggle", "sway"),
    ("wobble", "wobble"),
    ("arc", "arc"),
    ("throw", "arc"),
    ("toss", "arc"),
    ("pop", "pop"),
    ("reveal", "pop"),
    ("shake", "shake"),
    ("vibrate", "shake"),
    ("orbit", "orbit"),
    ("circle", "orbit"),
    ("bounce", "bounce"),
    ("hop", "bounce"),
    ("spin", "spin"),
    ("360", "turnaround"),
    ("turnaround", "turnaround"),
    ("zigzag", "zigzag"),
    ("spiral", "spiral"),
    ("launch", "launch"),
    ("swing", "swing"),
    ("swoop", "arc"),
    ("wander", "wander"),
    ("roam", "wander"),
    ("explore", "wander"),
    ("prowl", "wander"),
]


def extract_motion(clause: str) -> str | None:
    lower = clause.lower()
    for phrase, motion_id in MOTION_PHRASES:
        if re.search(rf"\b{re.escape(phrase)}\b", lower):
            return motion_id
    return None


def extract_motion_params(clause: str, motion: str, stage_radius: float = 25.0) -> dict[str, float]:
    """Heuristic params from ad-lib director language."""
    params: dict[str, float] = {}
    lower = clause.lower()

    m = re.search(rf"\b(?:height|up to|about)\s+{_NUM}\b", lower)
    if m:
        params["height"] = float(m.group(1))

    m = re.search(rf"\b{_NUM}\s*(?:m|meter|meters|metres|units?)\b", lower)
    if m and "height" not in params:
        params["height"] = float(m.group(1))

    m = re.search(r"\b(three|two|four|five|one|\d+)\s*hops?\b", lower)
    if m:
        token = m.group(1)
        params["hops"] = _WORD_NUM[token] if token in _WORD_NUM else float(token)

    if re.search(r"\b(high|tall|big bounce|athletic)\b", lower):
        params["height"] = max(params.get("height", 0), 2.8)
        params.setdefault("hops", 3)
    elif re.search(r"\b(low|small|subtle|soft|gentle|gently)\b", lower):
        if motion == "drop":
            params["decay"] = 0.25
        params["height"] = min(params.get("height", 999), 0.8) if motion == "bounce" else params.get("height", 0.8)
        params.setdefault("amplitude", 0.2)
    elif re.search(r"\b(aggressive|heavy|hard)\b", lower):
        params["height"] = max(params.get("height", 0), 2.5)
        params["decay"] = 0.65

    if re.search(r"\b(fast|quick|snappy)\b", lower):
        params["frequency"] = 3.0
    elif re.search(r"\b(slow|lazy|dreamy)\b", lower):
        params["frequency"] = 0.8

    m = re.search(rf"\b{_NUM}\s*(?:times|x|rotations?|turns?)\b", lower)
    if m:
        params["turns"] = float(m.group(1))

    if motion in ("float", "sway", "pulse", "drift") and "amplitude" not in params:
        params.setdefault("amplitude", stage_radius * 0.035 if motion == "float" else stage_radius * 0.05)

    if motion == "wander":
        params.setdefault("waypoints", 5.0)
        if re.search(r"\b(fast|quick|snappy)\b", lower):
            params["waypoints"] = 4.0
        elif re.search(r"\b(slow|lazy|dreamy|linger)\b", lower):
            params["waypoints"] = 7.0

    if motion == "orbit" and re.search(r"\b(?:orbit|circle)\s+(?:the\s+)?stage\b", lower):
        params["pivot"] = 1.0

    return params
