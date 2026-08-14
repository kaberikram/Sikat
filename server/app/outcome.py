"""What actually landed, said once, in plain words.

The crew's `say` line is written by the model *before* anything executes, so it
reports an intention: "sphere up on a three-count" is what the plan was, not what
the set now holds. When one object moves, that gap does not matter — the object
moving is the answer, and captioning it would only repeat what the room already
said (`docs/Thesis/Ambient_Design_Principles.md`, #1).

It matters when the director cannot see at a glance whether they were understood:
several objects moved at once, or a placement landed relative to something else.
Those are the cases this speaks for, and only those.
"""
from __future__ import annotations

from .schema import CommandPacket

_MOVE_WORDS = {
    "TRANSFORM_OBJECT": "moved",
    "ANIMATE_OBJECT": "animating",
    "SET_MATERIAL": "restyled",
    "REMOVE_OBJECT": "struck",
    "SET_KEYFRAMES": "keyframed",
}

_RELATION_WORDS = {
    "on": "onto",
    "above": "above",
    "beside": "beside",
    "in_front_of": "in front of",
    "behind": "behind",
    "left_of": "left of",
    "right_of": "right of",
}


def _names(packets: list[CommandPacket]) -> list[str]:
    out: list[str] = []
    for packet in packets:
        target = getattr(packet.payload, "target", None)
        name = getattr(target, "name", None) if target else None
        if name and name not in out:
            out.append(name)
    return out


def _join(names: list[str]) -> str:
    if len(names) == 1:
        return names[0]
    return f"{', '.join(names[:-1])} and {names[-1]}"


def _anchor_phrase(packets: list[CommandPacket]) -> str:
    anchors = {
        (p.payload.anchor.relation, p.payload.anchor.target.name)
        for p in packets
        if getattr(p.payload, "anchor", None) is not None
    }
    if len(anchors) != 1:
        return ""
    relation, name = anchors.pop()
    if not name:
        return ""
    return f" {_RELATION_WORDS.get(relation, relation.replace('_', ' '))} {name}"


def summarize(
    packets: list[CommandPacket], *, unresolved: list[str] | None = None
) -> str | None:
    """One factual line, or None when the set already answered for itself.

    Deliberately silent for the single-object, no-placement case: the prop
    moving *is* the acknowledgement, and a caption on top of it is the habit
    this project is trying not to have.
    """
    if not packets:
        return None

    by_command: dict[str, list[CommandPacket]] = {}
    for packet in packets:
        by_command.setdefault(packet.command, []).append(packet)

    spawns = by_command.get("SPAWN_OBJECT", [])
    lead: str | None = None

    for command, verb in _MOVE_WORDS.items():
        group = by_command.get(command)
        if not group:
            continue
        names = _names(group)
        if not names:
            continue
        placement = _anchor_phrase(group) if command == "TRANSFORM_OBJECT" else ""
        if len(names) < 2 and not placement:
            continue
        lead = f"{verb} {_join(names)}{placement}"
        break

    if lead is None and len(spawns) > 1:
        kinds = [p.payload.primitive for p in spawns]
        kind = kinds[0] if len(set(kinds)) == 1 else "props"
        lead = f"added {len(spawns)} {kind}s" if kind != "props" else f"added {len(spawns)} props"

    if lead is None:
        return None

    missing = [name for name in (unresolved or []) if name]
    if missing:
        return f"{lead} — {_join(missing)} not on set"
    return lead
