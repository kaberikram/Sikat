"""Track in-flight commands per object for barge-in supersede."""
from __future__ import annotations

from .schema import CommandPacket, Target, command_cancel_message

_active: dict[str, tuple[str, str]] = {}


def _packet_target_name(packet: CommandPacket) -> str | None:
    payload = packet.payload
    target: Target | None = getattr(payload, "target", None)
    if target is None:
        return None
    return target.name or target.id


def scope_key(target_name: str, command: str) -> str:
    return f"{target_name.lower()}:{command}"


def note_active(target_name: str, command: str, command_id: str) -> tuple[str, str] | None:
    """Register a new active command; return prior (command_id, command) if superseded."""
    key = scope_key(target_name, command)
    prior = _active.get(key)
    _active[key] = (command_id, command)
    return prior


def prior_for(target_name: str, command: str) -> tuple[str, str] | None:
    return _active.get(scope_key(target_name, command))


def clear() -> None:
    _active.clear()


def build_supersede_cancel(
    prior_command_id: str,
    *,
    superseded_by: str | None,
    target_name: str,
    command: str,
) -> dict:
    return command_cancel_message(
        prior_command_id,
        superseded_by=superseded_by,
        target=Target(name=target_name),
        command=command,
        reason="supersede",
    )


def build_stop_cancel(prior_command_id: str, target_name: str) -> dict:
    return command_cancel_message(
        prior_command_id,
        target=Target(name=target_name),
        command="ANIMATE_OBJECT",
        reason="stop",
    )
