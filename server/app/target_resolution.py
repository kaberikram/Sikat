"""Target resolution with ambiguity detection for clarify-and-wait."""
from __future__ import annotations

import math
import re

from .schema import SceneState

_AMBIGUITY_SCORE_GAP = 0.15


def _clause_words(clause: str) -> set[str]:
    return set(re.findall(r"[a-z]+", clause.lower()))


def _score_object(clause: str, obj_name: str) -> float:
    name_lower = obj_name.lower()
    clause_lower = clause.lower()
    if name_lower in clause_lower:
        return 1.0
    name_tokens = {t for t in re.split(r"[^a-z]+", name_lower) if len(t) >= 3}
    words = _clause_words(clause)
    overlap = words & name_tokens
    if not overlap:
        return 0.0
    return 0.5 + 0.1 * len(overlap)


def _color_filter(clause: str, scene: SceneState) -> list[str] | None:
    from .clause_handlers import COLOR_WORDS

    words = _clause_words(clause)
    for word, hex_color in COLOR_WORDS.items():
        if word not in words and f"{word}s" not in words:
            continue
        if "one" not in clause.lower() and word not in clause.lower():
            continue
        matches = []
        for obj in scene.objects:
            mat = obj.materialOverride
            obj_color = None
            if mat is not None:
                obj_color = mat.color if hasattr(mat, "color") else mat.get("color")
            if obj_color and obj_color.lower() == hex_color.lower():
                matches.append(obj.name)
        if matches:
            return matches
    return None


def _camera_right(scene: SceneState) -> tuple[float, float, float]:
    yaw = scene.virtualCamera.rotation[1]
    return (math.cos(yaw), 0.0, -math.sin(yaw))


def _spatial_sort(clause: str, names: list[str], scene: SceneState) -> list[str]:
    lower = clause.lower()
    if "on the left" not in lower and "on the right" not in lower:
        return names
    cam = scene.virtualCamera.sampled.position
    right = _camera_right(scene)

    def lateral(name: str) -> float:
        obj = next(o for o in scene.objects if o.name == name)
        pos = obj.sampled.position
        dx, _, dz = pos[0] - cam[0], 0.0, pos[2] - cam[2]
        return dx * right[0] + dz * right[2]

    reverse = "on the right" in lower
    return sorted(names, key=lateral, reverse=reverse)


def rank_targets(clause: str, scene: SceneState | None) -> list[tuple[str, float]]:
    if scene is None:
        return []
    color_matches = _color_filter(clause, scene)
    if color_matches:
        ranked = [(n, 1.0) for n in _spatial_sort(clause, color_matches, scene)]
        return ranked
    scored: list[tuple[str, float]] = []
    for obj in scene.objects:
        score = _score_object(clause, obj.name)
        if score > 0:
            scored.append((obj.name, score))
    scored.sort(key=lambda x: (-x[1], x[0]))
    if scored:
        names = [n for n, _ in scored]
        sorted_names = _spatial_sort(clause, names, scene)
        score_map = dict(scored)
        scored = [(n, score_map[n]) for n in sorted_names]
    return scored


def is_ambiguous(candidates: list[tuple[str, float]]) -> bool:
    if len(candidates) < 2:
        return False
    top, second = candidates[0][1], candidates[1][1]
    return top - second < _AMBIGUITY_SCORE_GAP


def ambiguous_options(candidates: list[tuple[str, float]], limit: int = 4) -> list[str]:
    return [name for name, _ in candidates[:limit]]


def resolve_option_answer(text: str, options: list[str]) -> str | None:
    lower = text.strip().lower()
    if not lower:
        return None
    ordinals = {
        "first": 0,
        "1": 0,
        "one": 0,
        "second": 1,
        "2": 1,
        "two": 1,
        "third": 2,
        "3": 2,
        "fourth": 3,
        "4": 3,
    }
    for word, idx in ordinals.items():
        if re.search(rf"\b{word}\b", lower) and idx < len(options):
            return options[idx]
    for opt in options:
        if opt.lower() in lower or lower in opt.lower():
            return opt
    return None
