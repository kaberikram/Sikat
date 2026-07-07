"""Advisory grammar reads for the LLM system prompt."""
from __future__ import annotations

from . import session_context
from .agents.asset_animator import default_spawn_name
from .schema import Intent, SceneState


def _intent_summary(intent: Intent) -> str:
    parts = [intent.action]
    if intent.target:
        parts.append(f"target={intent.target}")
    if intent.primitive:
        parts.append(f"primitive={intent.primitive}")
    if intent.color:
        parts.append(f"color={intent.color}")
    if intent.name:
        parts.append(f"name={intent.name}")
    motion = intent.motion or intent.preset
    if motion:
        parts.append(f"motion={motion}")
    if intent.motion_params:
        params = ", ".join(f"{k}={v:g}" for k, v in sorted(intent.motion_params.items()))
        parts.append(f"params=({params})")
    if intent.section:
        parts.append(f"section={intent.section}")
    if intent.playback_action:
        parts.append(f"playback={intent.playback_action}")
    if intent.mood:
        parts.append(f"mood={intent.mood}")
    return " ".join(parts)


def format_parse_hints(
    parsed: list[tuple[str, Intent | None]],
    scene: SceneState | None,
    *,
    handled_indices: set[int],
) -> str:
    """Build script-supervisor notes from per-clause grammar reads."""
    if not parsed or not any(intent is not None for _, intent in parsed):
        return ""

    lines = [
        "SCRIPT SUPERVISOR NOTES (advisory — the director's words always win):",
    ]
    for idx, (clause, intent) in enumerate(parsed):
        if intent is None:
            lines.append(f'- "{clause}" → (no grammar match)')
            continue
        handled = " [handled — do not re-emit]" if idx in handled_indices else ""
        summary = _intent_summary(intent)
        if intent.action == "spawn" and idx in handled_indices:
            summary += f" name={default_spawn_name(intent)}"
        lines.append(f'- "{clause}" → {summary}{handled}')

    last = session_context.last_target()
    if last:
        lines.append(f"Last mentioned object: {last}")

    last_xform = session_context.last_transform()
    if last_xform and last_xform.target:
        parts = [f"Last transform on {last_xform.target}"]
        if last_xform.mode:
            parts.append(f"mode={last_xform.mode}")
        if last_xform.position:
            parts.append(f"position={last_xform.position}")
        lines.append(" ".join(parts))

    lines.append(
        "Clauses marked handled are done — emit no intent for them. Unhandled "
        "clauses are yours; interpret creatively (motion, choreography, mood, "
        "compound builds)."
    )
    return "\n".join(lines)
