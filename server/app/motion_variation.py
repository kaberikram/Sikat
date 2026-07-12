"""Per-invocation variation for instant / LLM motion — avoids identical replays."""
from __future__ import annotations


def variation_seed(command_id: str | None) -> float:
    if command_id:
        return float(abs(hash(command_id)) % 100_000)
    return float(abs(hash("sikat")) % 100_000)


def unit_variation(seed: float, salt: int) -> float:
    """Deterministic pseudo-random float in [0, 1) derived from seed + salt."""
    return ((int(seed) + salt * 7919) % 1000) / 1000.0


_unit = unit_variation


def enrich_motion_params(
    params: dict[str, float] | None,
    motion: str,
    command_id: str | None,
    stage_radius: float = 1.0,
) -> dict[str, float]:
    """Fill unset params from a command seed so each cue feels slightly different."""
    out = dict(params or {})
    seed = out.get("seed", variation_seed(command_id))
    out["seed"] = seed
    r0, r1, r2 = _unit(seed, 1), _unit(seed, 2), _unit(seed, 3)

    if motion == "bounce":
        out.setdefault("hops", 2.0 + int(r0 * 2.99))
        out.setdefault("height", stage_radius * (0.35 + r1 * 0.5))
        out.setdefault("decay", 0.4 + r2 * 0.38)
    elif motion == "drop":
        out.setdefault("height", stage_radius * (0.08 + r0 * 0.14))
        out.setdefault("decay", 0.35 + r1 * 0.45)
    elif motion == "float":
        out.setdefault("amplitude", stage_radius * (0.02 + r0 * 0.04))
        out.setdefault("frequency", 0.7 + r1 * 2.2)
    elif motion == "sway":
        out.setdefault("amplitude", stage_radius * (0.04 + r0 * 0.1))
        out.setdefault("frequency", 0.6 + r1 * 1.8)
    elif motion == "wander":
        out.setdefault("waypoints", 4.0 + int(r0 * 3.99))
    elif motion in ("orbit", "drift", "arc", "spiral", "figure8"):
        out.setdefault("radius", stage_radius * (0.12 + r0 * 0.35))

    return out
