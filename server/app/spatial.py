"""Spatial reasoning over the scene snapshot — pure, so it can be tested.

The crew used to read a table of coordinates and scale multipliers against
unknown base geometry, which made "put a cup on the pedestal" unanswerable: a
scale of 2.8 tells you nothing about where a surface is. With world-space bounds
on the wire, this turns those numbers into the things a person standing in the
room would notice — how big something is, what it is resting on, what is beside
it, whether it is on the set, and where it sits in the shot.

Deliberately free of pydantic and formatting concerns: `scene_context.py` is the
shell that renders these into the brief. Same policy/shell split as
`stage-placement.ts` and `cursor-lifecycle.ts` on the client.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

Vec3 = tuple[float, float, float]

# ---------------------------------------------------------------------------
# tolerances
# ---------------------------------------------------------------------------

REST_GAP_M = 0.06
"""Vertical slack allowed between a base and the surface below it.

Objects settle a centimetre or two off a surface (tween easing, authored
offsets, mesh origins that are not flush), and a strict test would report a
shoe hovering above its own pedestal. Wide enough to forgive that, tight enough
that a floating object is not called 'resting'."""

OVERLAP_MIN = 0.25
"""Fraction of the smaller footprint that must sit over the supporter.

An object clipping a pedestal's corner is beside it, not on it."""

NEAR_GAP_M = 0.6
"""Horizontal gap between footprints that still reads as 'next to'."""

MAX_NEIGHBOURS = 2
"""Neighbours named per object. The brief rides every request — listing every
pair turns a scene description into an adjacency matrix."""


@dataclass(frozen=True)
class Box:
    """World-space AABB."""

    min: Vec3
    max: Vec3

    @property
    def size(self) -> Vec3:
        return (
            self.max[0] - self.min[0],
            self.max[1] - self.min[1],
            self.max[2] - self.min[2],
        )

    @property
    def center(self) -> Vec3:
        return (
            (self.min[0] + self.max[0]) / 2,
            (self.min[1] + self.max[1]) / 2,
            (self.min[2] + self.max[2]) / 2,
        )

    @property
    def top(self) -> float:
        return self.max[1]

    @property
    def bottom(self) -> float:
        return self.min[1]

    @property
    def footprint_radius(self) -> float:
        """Half the larger horizontal extent — a single number for clearance."""
        sx, _, sz = self.size
        return max(sx, sz) / 2


@dataclass
class Placed:
    """An object reduced to what matters spatially."""

    name: str
    box: Box
    kind: str | None = None


@dataclass
class Relations:
    """What is true about one object, relative to everything else."""

    resting_on: str | None = None
    supporting: list[str] = field(default_factory=list)
    near: list[str] = field(default_factory=list)
    stage_distance: float | None = None
    on_stage: bool | None = None
    camera_distance: float | None = None
    camera_bearing: str | None = None


def _overlap_1d(a_min: float, a_max: float, b_min: float, b_max: float) -> float:
    return max(0.0, min(a_max, b_max) - max(a_min, b_min))


def horizontal_overlap(a: Box, b: Box) -> float:
    """Shared floor area as a fraction of the smaller footprint, 0..1."""
    ox = _overlap_1d(a.min[0], a.max[0], b.min[0], b.max[0])
    oz = _overlap_1d(a.min[2], a.max[2], b.min[2], b.max[2])
    if ox <= 0 or oz <= 0:
        return 0.0
    area_a = (a.max[0] - a.min[0]) * (a.max[2] - a.min[2])
    area_b = (b.max[0] - b.min[0]) * (b.max[2] - b.min[2])
    smaller = min(area_a, area_b)
    if smaller <= 0:
        return 0.0
    return min(1.0, (ox * oz) / smaller)


def horizontal_gap(a: Box, b: Box) -> float:
    """Edge-to-edge distance on the floor plane. 0 when footprints overlap."""
    dx = max(0.0, max(a.min[0] - b.max[0], b.min[0] - a.max[0]))
    dz = max(0.0, max(a.min[2] - b.max[2], b.min[2] - a.max[2]))
    return math.hypot(dx, dz)


def rests_on(upper: Box, lower: Box) -> bool:
    """True when `upper` sits on `lower`'s top surface.

    Both conditions matter: the vertical gap has to be small *and* the footprint
    has to genuinely overlap. Height alone would call two objects side by side
    on the same table a stack.
    """
    gap = upper.bottom - lower.top
    if gap < -REST_GAP_M or gap > REST_GAP_M:
        return False
    return horizontal_overlap(upper, lower) >= OVERLAP_MIN


def camera_bearing(
    obj_center: Vec3, cam_pos: Vec3, cam_forward: Vec3
) -> tuple[float, str]:
    """Distance from the lens, and roughly where it falls in the shot.

    'behind' is worth stating plainly: an object the camera cannot see is the
    single most useful thing to know before being asked to reframe.
    """
    to_obj = (
        obj_center[0] - cam_pos[0],
        obj_center[1] - cam_pos[1],
        obj_center[2] - cam_pos[2],
    )
    distance = math.sqrt(sum(c * c for c in to_obj))
    if distance < 1e-6:
        return 0.0, "at the lens"

    fwd_len = math.sqrt(sum(c * c for c in cam_forward))
    if fwd_len < 1e-6:
        return distance, "unknown"
    fwd = tuple(c / fwd_len for c in cam_forward)
    unit = tuple(c / distance for c in to_obj)

    depth = sum(u * f for u, f in zip(unit, fwd))
    if depth < 0:
        return distance, "behind camera"

    # Camera right on the floor plane: forward × world-up, flattened.
    right = (fwd[2], 0.0, -fwd[0])
    r_len = math.hypot(right[0], right[2])
    if r_len < 1e-6:
        return distance, "in front"
    right = (right[0] / r_len, 0.0, right[2] / r_len)
    lateral = sum(u * r for u, r in zip(unit, right))

    if abs(lateral) < 0.15:
        return distance, "centre frame"
    return distance, "frame right" if lateral > 0 else "frame left"


def forward_from_euler(rotation: Vec3) -> Vec3:
    """Camera forward (-Z) for an XYZ euler, matching the client's convention."""
    rx, ry, _ = rotation
    cos_x = math.cos(rx)
    return (
        -math.sin(ry) * cos_x,
        math.sin(rx),
        -math.cos(ry) * cos_x,
    )


def describe_scene(
    placed: list[Placed],
    stage_center: Vec3 | None = None,
    stage_radius: float | None = None,
    cam_pos: Vec3 | None = None,
    cam_forward: Vec3 | None = None,
) -> dict[str, Relations]:
    """Relations for every object, keyed by name.

    One pass over the pairs; the cast on a set is small enough that O(n²) is
    cheaper than any index would be.
    """
    out = {p.name: Relations() for p in placed}

    for a in placed:
        rel = out[a.name]
        for b in placed:
            if a.name == b.name:
                continue
            if rests_on(a.box, b.box):
                # Nearest supporter wins when something sits on a stack.
                if rel.resting_on is None or b.box.top > next(
                    (p.box.top for p in placed if p.name == rel.resting_on), -math.inf
                ):
                    rel.resting_on = b.name
            elif rests_on(b.box, a.box):
                # B is stacked on A. "supporting" already says so; also calling it
                # "next to" reads as two separate facts about one relationship.
                continue
            elif horizontal_gap(a.box, b.box) <= NEAR_GAP_M:
                rel.near.append(b.name)

        # Closest neighbours first, so the trim keeps the useful ones.
        rel.near.sort(key=lambda n: horizontal_gap(a.box, _box_of(placed, n)))
        rel.near = rel.near[:MAX_NEIGHBOURS]

        if stage_center is not None:
            cx, _, cz = stage_center
            ax, _, az = a.box.center
            rel.stage_distance = math.hypot(ax - cx, az - cz)
            if stage_radius is not None:
                rel.on_stage = rel.stage_distance <= stage_radius

        if cam_pos is not None and cam_forward is not None:
            rel.camera_distance, rel.camera_bearing = camera_bearing(
                a.box.center, cam_pos, cam_forward
            )

    for name, rel in out.items():
        rel.supporting = sorted(
            other for other, r in out.items() if r.resting_on == name
        )

    return out


def _box_of(placed: list[Placed], name: str) -> Box:
    for p in placed:
        if p.name == name:
            return p.box
    raise KeyError(name)
