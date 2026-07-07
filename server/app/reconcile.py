"""Semantic reconciliation between grammar-staged intents and LLM intents."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from . import session_context
from .schema import Intent

ReconcileVerdict = Literal[
    "duplicate", "refine", "replace", "amend_spawn", "new", "suppress"
]


@dataclass
class GrammarEmit:
    intent: Intent
    matched: bool = False
    clause: str | None = None


def _resolve_target(intent: Intent) -> str | None:
    if intent.target:
        return intent.target
    return session_context.last_target()


def _motion_id(intent: Intent) -> str | None:
    return intent.motion or intent.preset


def _within_tol(
    a: float, b: float, *, rel: float = 0.25, abs_tol: float = 0.2
) -> bool:
    if a == b:
        return True
    if abs(a - b) <= abs_tol:
        return True
    denom = max(abs(a), abs(b), 1e-9)
    return abs(a - b) / denom <= rel


def _colors_equal(a: str | None, b: str | None) -> bool:
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    return a.lower() == b.lower()


def _spawn_params_match(grammar: Intent, llm: Intent) -> bool:
    if grammar.primitive != llm.primitive:
        return False
    if not _colors_equal(grammar.color, llm.color):
        return False
    g_name = (grammar.name or "").strip().lower()
    l_name = (llm.name or "").strip().lower()
    if g_name or l_name:
        return g_name == l_name
    return True


def _spawn_amendable(grammar: Intent, llm: Intent) -> bool:
    """Name-only amend; color tweaks are duplicate (set_material races spawn)."""
    if grammar.primitive != llm.primitive:
        return False
    g_name = (grammar.name or "").strip().lower()
    l_name = (llm.name or "").strip().lower()
    return bool(g_name or l_name) and g_name != l_name


def _same_identity(grammar: Intent, llm: Intent) -> bool:
    if grammar.action != llm.action:
        return False
    if grammar.action == "spawn":
        return grammar.primitive == llm.primitive
    if grammar.action in ("animate", "transform", "set_material", "remove"):
        g_target = _resolve_target(grammar)
        l_target = _resolve_target(llm)
        return bool(g_target and l_target and g_target.lower() == l_target.lower())
    if grammar.action == "update_fx":
        return grammar.section == llm.section
    if grammar.action == "playback":
        return grammar.playback_action == llm.playback_action
    if grammar.action in ("update_lights", "set_scene", "move_camera"):
        return True
    return False


def _motion_params_close(a: dict[str, float] | None, b: dict[str, float] | None) -> bool:
    if not a and not b:
        return True
    if not a or not b:
        return False
    keys = set(a) & set(b)
    if not keys:
        return not a and not b
    return all(_within_tol(a[k], b[k], rel=0.25, abs_tol=0.2) for k in keys)


def _vec3_close(
    a: tuple[float, float, float] | None,
    b: tuple[float, float, float] | None,
    *,
    rel: float = 0.15,
    abs_tol: float = 0.25,
) -> bool:
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    return all(_within_tol(a[i], b[i], rel=rel, abs_tol=abs_tol) for i in range(3))


def _compare_params(grammar: Intent, llm: Intent) -> ReconcileVerdict:
    if grammar.action in ("playback", "set_scene"):
        return "duplicate"

    if grammar.action == "spawn":
        if _spawn_params_match(grammar, llm):
            return "duplicate"
        return "amend_spawn"

    if grammar.action == "animate":
        g_motion = _motion_id(grammar)
        l_motion = _motion_id(llm)
        if llm.track_keyframes and (g_motion or grammar.preset):
            return "replace"
        if g_motion and l_motion and g_motion.lower() != l_motion.lower():
            return "replace"
        if g_motion and l_motion and g_motion.lower() == l_motion.lower():
            if _motion_params_close(grammar.motion_params, llm.motion_params):
                return "duplicate"
            return "refine"
        if llm.track_keyframes:
            return "replace"
        return "refine"

    if grammar.action == "transform":
        if grammar.mode != llm.mode:
            return "refine"
        if (
            _vec3_close(grammar.position, llm.position)
            and _vec3_close(grammar.rotation, llm.rotation)
            and _vec3_close(grammar.scale, llm.scale)
        ):
            return "duplicate"
        return "refine"

    if grammar.action == "set_material":
        if _colors_equal(grammar.color, llm.color):
            return "duplicate"
        return "refine"

    if grammar.action == "update_fx":
        if grammar.fx_enabled == llm.fx_enabled:
            if grammar.fx_set and llm.fx_set:
                g_vals = {s.key: s.value for s in grammar.fx_set}
                l_vals = {s.key: s.value for s in llm.fx_set}
                if all(
                    k in l_vals and abs(g_vals[k] - l_vals[k]) <= 0.1 for k in g_vals
                ):
                    return "duplicate"
            elif not grammar.fx_set and not llm.fx_set:
                return "duplicate"
        return "refine"

    if grammar.action == "update_lights":
        scalar_keys = ("ambient_intensity", "key_intensity")
        close = all(
            getattr(grammar, k, None) is None
            or getattr(llm, k, None) is None
            or abs(getattr(grammar, k) - getattr(llm, k)) <= 0.1
            for k in scalar_keys
        )
        if close and _colors_equal(grammar.key_color, llm.key_color):
            return "duplicate"
        return "refine"

    if grammar.action == "move_camera":
        if (
            _vec3_close(grammar.position, llm.position)
            and _vec3_close(grammar.rotation, llm.rotation)
            and (grammar.fov is None or llm.fov is None or abs(grammar.fov - llm.fov) <= 0.1)
        ):
            return "duplicate"
        return "refine"

    return "duplicate"


def reconcile(
    llm_intent: Intent, grammar_emits: list[GrammarEmit]
) -> tuple[ReconcileVerdict, GrammarEmit | None]:
    """Match one LLM intent against unconsumed grammar emits (greedy)."""
    if llm_intent.action == "spawn":
        unmatched_spawns = [
            g for g in grammar_emits if not g.matched and g.intent.action == "spawn"
        ]
        if unmatched_spawns:
            emit = unmatched_spawns[0]
            grammar = emit.intent
            if grammar.primitive != llm_intent.primitive:
                return "suppress", emit
            if _spawn_params_match(grammar, llm_intent):
                emit.matched = True
                return "duplicate", emit
            if _spawn_amendable(grammar, llm_intent):
                emit.matched = True
                return "duplicate", emit
            emit.matched = True
            return "duplicate", emit

    for emit in grammar_emits:
        if emit.matched:
            continue
        if not _same_identity(emit.intent, llm_intent):
            continue
        verdict = _compare_params(emit.intent, llm_intent)
        emit.matched = True
        return verdict, emit

    if llm_intent.action == "spawn":
        unmatched_spawns = [
            g for g in grammar_emits if not g.matched and g.intent.action == "spawn"
        ]
        if unmatched_spawns:
            return "suppress", unmatched_spawns[0]

    return "new", None
