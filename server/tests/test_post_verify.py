"""Post-apply verification tests."""
from app.schema import (
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
