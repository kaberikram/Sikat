"""Post-apply verification tests."""
from app.schema import (
    BoundsSnapshot,
    ObjectSnapshot,
    SampledTransform,
    Target,
    TransformObjectPacket,
    TransformObjectPayload,
)
from app.verify import check_apply
from tests.helpers import scene_kw, scene_with


def test_floor_clip_correction():
    scene = scene_with("BOX")
    scene.objects[0].sampled = SampledTransform(
        position=(0.0, -0.5, 0.0), rotation=(0, 0, 0), scale=(1, 1, 1)
    )
    packet = TransformObjectPacket(
        payload=TransformObjectPayload(
            target=Target(name="BOX"),
            mode="absolute",
            position=(0.0, -0.5, 0.0),
        )
    )
    correction = check_apply(None, packet, scene)
    assert correction is not None
    assert "floor" in correction.message
    assert correction.packet.refinement is True
    assert correction.packet.payload.position[1] >= 0.05


def test_off_stage_correction():
    scene = scene_kw(
        objects=[
            ObjectSnapshot(
                id="id0",
                name="BOX",
                sampled=SampledTransform(
                    position=(30.0, 1.0, 30.0), rotation=(0, 0, 0), scale=(1, 1, 1)
                ),
            )
        ]
    )
    packet = TransformObjectPacket(
        payload=TransformObjectPayload(
            target=Target(name="BOX"),
            mode="absolute",
            position=(30.0, 1.0, 30.0),
        )
    )
    correction = check_apply(None, packet, scene)
    assert correction is not None
    assert "off stage" in correction.message


def test_no_correction_when_ok():
    scene = scene_with("BOX")
    packet = TransformObjectPacket(
        payload=TransformObjectPayload(
            target=Target(name="BOX"),
            mode="absolute",
            position=(0.0, 1.0, 0.0),
        )
    )
    scene.objects[0].sampled.position = (0.0, 1.0, 0.0)
    assert check_apply(None, packet, scene) is None


def _sphere_at(name: str, x: float, z: float, radius: float = 0.1) -> ObjectSnapshot:
    return ObjectSnapshot(
        id=name.lower(),
        name=name,
        position=(x, 0.5, z),
        bounds=BoundsSnapshot(
            min=(x - radius, 0.4, z - radius), max=(x + radius, 0.6, z + radius)
        ),
        sampled=SampledTransform(
            position=(x, 0.5, z), rotation=(0, 0, 0), scale=(1, 1, 1)
        ),
    )


def test_crowded_group_member_gets_pushed_clear():
    """Two props of a group landed inside each other — space them out."""
    scene = scene_kw(objects=[_sphere_at("A", 0.0, 0.0), _sphere_at("B", 0.02, 0.0)])
    packet = TransformObjectPacket(
        payload=TransformObjectPayload(
            target=Target(name="A"), mode="absolute", position=(0.0, 0.5, 0.0)
        )
    )
    correction = check_apply(None, packet, scene)
    assert correction is not None
    assert "inside B" in correction.message
    moved = correction.packet.payload.position
    # Two 0.1-radius footprints clear each other at 0.2 apart.
    assert abs(moved[0] - 0.02) >= 0.2 - 1e-6
    assert moved[1] == 0.5  # height is the relation's business, not ours


def test_props_merely_side_by_side_are_left_alone():
    scene = scene_kw(objects=[_sphere_at("A", 0.0, 0.0), _sphere_at("B", 0.25, 0.0)])
    packet = TransformObjectPacket(
        payload=TransformObjectPayload(
            target=Target(name="A"), mode="absolute", position=(0.0, 0.5, 0.0)
        )
    )
    assert check_apply(None, packet, scene) is None
