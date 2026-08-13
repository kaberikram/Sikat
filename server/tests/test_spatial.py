"""Spatial relations — the reasoning that makes "on the pedestal" answerable."""
import math

from app.spatial import (
    Box,
    Placed,
    camera_bearing,
    describe_scene,
    forward_from_euler,
    horizontal_gap,
    horizontal_overlap,
    rests_on,
)


def box(cx, cy, cz, sx, sy, sz) -> Box:
    """A box by centre and size — how a person describes a prop."""
    return Box(
        min=(cx - sx / 2, cy - sy / 2, cz - sz / 2),
        max=(cx + sx / 2, cy + sy / 2, cz + sz / 2),
    )


# ---- the SET DAY stack, which is the case that prompted all this ----

PEDESTAL = Placed("PEDESTAL", box(0, 0.42, 0, 0.54, 0.84, 0.54), "cylinder")
SNEAKER = Placed("SNEAKER_ONE", box(0, 0.94, 0, 0.26, 0.11, 0.10), "sneaker")
SIGN = Placed("SET_SIGN", box(0, 1.5, -1.0, 0.5, 0.25, 0.02), "text")


def test_the_shoe_is_on_the_pedestal():
    assert rests_on(SNEAKER.box, PEDESTAL.box)
    assert not rests_on(PEDESTAL.box, SNEAKER.box)


def test_the_pedestal_reports_its_own_top():
    # The number the crew could never work out from `scale (1.8,2.8,1.8)`.
    assert PEDESTAL.box.top == 0.84


def test_something_hovering_is_not_resting():
    floating = box(0, 1.4, 0, 0.2, 0.2, 0.2)
    assert not rests_on(floating, PEDESTAL.box)


def test_a_small_settling_gap_still_counts_as_resting():
    # Tweens and mesh origins leave a centimetre or two; a strict test would
    # report the shoe hovering above its own pedestal.
    settled = box(0, 0.87 + 0.02, 0, 0.26, 0.11, 0.10)
    assert rests_on(settled, PEDESTAL.box)


def test_side_by_side_at_the_same_height_is_not_a_stack():
    # Height alone would call these stacked; the footprint test is what stops it.
    left = box(-0.5, 0.5, 0, 0.2, 0.2, 0.2)
    right = box(0.5, 0.5 + 0.2, 0, 0.2, 0.2, 0.2)
    assert not rests_on(right, left)


def test_a_corner_clip_is_beside_not_on():
    perched = box(0.4, 0.94, 0.4, 0.1, 0.1, 0.1)
    assert horizontal_overlap(perched, PEDESTAL.box) < 0.25
    assert not rests_on(perched, PEDESTAL.box)


# ---- footprints ----


def test_overlap_is_relative_to_the_smaller_object():
    small = box(0, 0, 0, 0.1, 1, 0.1)
    large = box(0, 0, 0, 2, 1, 2)
    assert horizontal_overlap(small, large) == 1.0


def test_gap_is_zero_when_footprints_overlap():
    assert horizontal_gap(SNEAKER.box, PEDESTAL.box) == 0.0


def test_gap_measures_edge_to_edge_not_centre_to_centre():
    a = box(0, 0, 0, 1, 1, 1)
    b = box(3, 0, 0, 1, 1, 1)
    assert math.isclose(horizontal_gap(a, b), 2.0)


# ---- the whole scene ----


def test_the_stack_reads_both_ways():
    rel = describe_scene([PEDESTAL, SNEAKER, SIGN])
    assert rel["SNEAKER_ONE"].resting_on == "PEDESTAL"
    assert rel["PEDESTAL"].supporting == ["SNEAKER_ONE"]
    assert rel["SET_SIGN"].resting_on is None


def test_neighbours_are_named_and_capped():
    cast = [PEDESTAL, SNEAKER] + [
        Placed(f"PROP_{i}", box(0.4 + i * 0.05, 0.1, 0, 0.1, 0.2, 0.1)) for i in range(5)
    ]
    rel = describe_scene(cast)
    assert len(rel["PEDESTAL"].near) <= 2


def test_stage_membership():
    far = Placed("STRAY", box(5, 0.2, 0, 0.2, 0.4, 0.2))
    rel = describe_scene([PEDESTAL, far], stage_center=(0, 0, 0), stage_radius=1.0)
    assert rel["PEDESTAL"].on_stage is True
    assert rel["STRAY"].on_stage is False
    assert math.isclose(rel["STRAY"].stage_distance, 5.0)


# ---- the shot ----


def test_an_object_down_the_lens_is_centre_frame():
    # Camera at +Z looking toward -Z, the editor's default.
    dist, bearing = camera_bearing((0, 1, 0), (0, 1, 3), (0, 0, -1))
    assert math.isclose(dist, 3.0)
    assert bearing == "centre frame"


def test_left_and_right_are_from_the_camera_not_the_world():
    _, left = camera_bearing((-2, 1, 0), (0, 1, 3), (0, 0, -1))
    _, right = camera_bearing((2, 1, 0), (0, 1, 3), (0, 0, -1))
    assert {left, right} == {"frame left", "frame right"}
    assert left != right


def test_something_behind_the_lens_is_called_out():
    # The most useful single fact before being asked to reframe.
    _, bearing = camera_bearing((0, 1, 6), (0, 1, 3), (0, 0, -1))
    assert bearing == "behind camera"


def test_default_camera_rotation_points_down_negative_z():
    fx, fy, fz = forward_from_euler((0.0, 0.0, 0.0))
    assert math.isclose(fx, 0.0, abs_tol=1e-9)
    assert math.isclose(fy, 0.0, abs_tol=1e-9)
    assert math.isclose(fz, -1.0)


def test_a_yawed_camera_turns_its_frame_with_it():
    # Yawed 90° left, so world +X is now straight ahead.
    fwd = forward_from_euler((0.0, -math.pi / 2, 0.0))
    _, bearing = camera_bearing((3, 0, 0), (0, 0, 0), fwd)
    assert bearing == "centre frame"


def test_a_supporter_is_not_also_listed_as_a_neighbour():
    # "supporting SNEAKER_ONE · next to SNEAKER_ONE" reads as two facts about
    # what is really one relationship.
    rel = describe_scene([PEDESTAL, SNEAKER])
    assert rel["PEDESTAL"].supporting == ["SNEAKER_ONE"]
    assert rel["PEDESTAL"].near == []
    assert rel["SNEAKER_ONE"].near == []
