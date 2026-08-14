"""Target resolution with ambiguity detection for clarify-and-wait."""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

from .schema import SceneState

_AMBIGUITY_SCORE_GAP = 0.15


def _clause_words(clause: str) -> set[str]:
    return set(re.findall(r"[a-z]+", clause.lower()))


def _singular(word: str) -> str:
    """Crude English stem, enough to make a plural name a plural referent.

    "spheres" scored 0.0 against SPHERE_SPAWN because the raw word was compared
    to the raw token — so "put all 3 spheres on the pedestal" had no referent at
    all and read as being about something not on set. Nothing downstream could
    recover from that, which is why the sentence ended up spawning.
    """
    lower = word.lower()
    if len(lower) > 3 and lower.endswith("es") and lower[-3] in "sxzh":
        return lower[:-2]
    if len(lower) > 3 and lower.endswith("s") and not lower.endswith("ss"):
        return lower[:-1]
    return lower


def _stems(words: set[str]) -> set[str]:
    return {_singular(w) for w in words}


def _score_object(clause: str, obj_name: str) -> float:
    name_lower = obj_name.lower()
    clause_lower = clause.lower()
    # Whole name only. A bare `in` let SPHERE_SPAWN score a perfect match on
    # "make SPHERE_SPAWN_2 red", tying with the object actually named and
    # turning an unambiguous instruction into a question. Same boundary rule
    # `_find_scene_target` already uses.
    if re.search(rf"(?<![a-z0-9_]){re.escape(name_lower)}(?![a-z0-9_])", clause_lower):
        return 1.0
    name_tokens = {t for t in re.split(r"[^a-z]+", name_lower) if len(t) >= 3}
    words = _clause_words(clause)
    overlap = _stems(words) & _stems(name_tokens)
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


_LLM_TARGET_MIN_SCORE = 0.5


def resolve_llm_target(name: str, scene: SceneState | None) -> tuple[str | None, str]:
    """Resolve an LLM-emitted target name against the live scene.

    Returns (resolved_name_or_None, reason) where reason is exact|fuzzy|none.
    """
    if not name or scene is None or not scene.objects:
        return None, "none"
    for obj in scene.objects:
        if obj.name == name:
            return obj.name, "exact"
    ranked = rank_targets(name, scene)
    if ranked and ranked[0][1] >= _LLM_TARGET_MIN_SCORE:
        return ranked[0][0], "fuzzy"
    return None, "none"


# ---------------------------------------------------------------------------
# Groups: "all three spheres", "both boxes", "them"
# ---------------------------------------------------------------------------

_COLLECTIVE_WORDS = frozenset(
    {"all", "every", "each", "both", "them", "those", "these", "everything"}
)

_PRONOUN_GROUP = frozenset({"them", "those", "these"})

_WORD_COUNTS = {
    "both": 2,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
}


@dataclass(frozen=True)
class Resolution:
    """What a target phrase turned out to mean on this set.

    One return shape for every caller, because "the sphere" and "all the
    spheres" differ only in how many names come back — and the third case, two
    equally good answers, is a question rather than a name.
    """

    names: list[str] = field(default_factory=list)
    reason: str = "none"
    """exact | fuzzy | group | ambiguous | none"""
    options: list[str] = field(default_factory=list)
    """Candidates to offer when `reason` is ambiguous."""

    @property
    def is_group(self) -> bool:
        return self.reason == "group"


def _spoken_count(words: list[str]) -> int | None:
    for word in words:
        if word in _WORD_COUNTS:
            return _WORD_COUNTS[word]
        if word.isdigit():
            value = int(word)
            if 2 <= value <= 12:
                return value
    return None


def _names_the_kind(phrase: str, scene: SceneState) -> list[str]:
    """Objects of a primitive kind the phrase names — "spheres" → every sphere.

    Reads the same synonym table the grammar uses, so "balls" and "spheres"
    gather the same props. Matches an object's declared primitive first, then
    its name tokens, so a hand-named PEDESTAL_CYL still answers to "cylinders".
    """
    from .clause_handlers import PRIMITIVE_WORDS

    kinds = {
        PRIMITIVE_WORDS[stem]
        for stem in _stems(_clause_words(phrase))
        if stem in PRIMITIVE_WORDS
    }
    if not kinds:
        return []
    matches: list[str] = []
    for obj in scene.objects:
        if obj.primitive and obj.primitive.lower() in kinds:
            matches.append(obj.name)
            continue
        tokens = _stems({t for t in re.split(r"[^a-z]+", obj.name.lower()) if t})
        if any(
            PRIMITIVE_WORDS.get(token) in kinds
            for token in tokens
            if token in PRIMITIVE_WORDS
        ):
            matches.append(obj.name)
    return matches


def _says_group(phrase: str, scene: SceneState) -> bool:
    """True when the phrase is about more than one thing.

    Either it says so outright ("all", "both", "them") or it uses a plural noun
    that is not itself the name of something on set — `SPHERES` as a literal
    object name is one object, however it is spelled.
    """
    words = _clause_words(phrase)
    if words & _COLLECTIVE_WORDS:
        return True
    lower = phrase.strip().lower()
    if any(obj.name.lower() == lower for obj in scene.objects):
        return False
    return any(
        len(w) > 3 and w.endswith("s") and not w.endswith("ss") and _singular(w) != w
        for w in words
    )


def resolve_target_group(
    phrase: str,
    scene: SceneState | None,
    *,
    last_group: list[str] | None = None,
) -> list[str]:
    """Every object a plural or collective phrase refers to, in scene order.

    Returns [] when the phrase names one thing (or nothing) — callers fall back
    to single-target resolution, so this is safe to try first.
    """
    if not phrase or scene is None or not scene.objects:
        return []
    if not _says_group(phrase, scene):
        return []

    words = _clause_words(phrase)
    matches = _color_filter(phrase, scene) or []
    if not matches:
        matches = _names_the_kind(phrase, scene)
    if not matches and words & _PRONOUN_GROUP and last_group:
        live = {obj.name for obj in scene.objects}
        matches = [name for name in last_group if name in live]
    if not matches and "everything" in words:
        matches = [obj.name for obj in scene.objects]
    if not matches:
        # "all of them" with no noun and no memory: every tie at the top of the
        # ranking is a plausible member, which is what a collective word means.
        ranked = rank_targets(phrase, scene)
        if ranked:
            top = ranked[0][1]
            matches = [name for name, score in ranked if score >= top]
    if len(matches) < 2:
        return []

    ordered = [obj.name for obj in scene.objects if obj.name in set(matches)]
    count = _spoken_count(sorted(words, key=len))
    if count is not None and count < len(ordered):
        # "the two on the left" narrows; "all 3 spheres" when four are standing
        # there does not — the director is counting loosely, and moving three of
        # four is a worse answer than moving all four and saying so.
        lower = phrase.lower()
        if "on the left" in lower or "on the right" in lower:
            return _spatial_sort(phrase, ordered, scene)[:count]
    return ordered


def resolve_target_or_group(
    name: str | None,
    scene: SceneState | None,
    *,
    last_group: list[str] | None = None,
) -> Resolution:
    """Single entry point: one name, a group of names, or a question to ask."""
    if not name or scene is None or not scene.objects:
        return Resolution()

    group = resolve_target_group(name, scene, last_group=last_group)
    if group:
        return Resolution(names=group, reason="group")

    for obj in scene.objects:
        if obj.name == name:
            return Resolution(names=[obj.name], reason="exact")

    ranked = rank_targets(name, scene)
    if not ranked or ranked[0][1] < _LLM_TARGET_MIN_SCORE:
        return Resolution()
    if is_ambiguous(ranked):
        # Two equally good answers is not a resolution, it is a question. This
        # used to take ranked[0] regardless, so on a set of three spheres "move
        # the sphere" silently moved whichever sorted first.
        return Resolution(
            names=[ranked[0][0]], reason="ambiguous", options=ambiguous_options(ranked)
        )
    return Resolution(names=[ranked[0][0]], reason="fuzzy")


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
