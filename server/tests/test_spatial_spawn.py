"""Spatial spawn — "beside the cylinder" surviving all the way to the packet.

The relations themselves are proven in test_spatial.py. What is covered here is
the wire: a relationship the director says has to reach SPAWN_OBJECT, or the
client has nothing to resolve and the prop lands at stage centre.
"""
from app.agents.asset_animator import AssetAnimator
from app.agents.producer import Producer
from app.clause_handlers import find_placement_anchor
from app.fallback_parser import parse
from app.schema import Intent, PlacementAnchor, Target
from app import session_context

from tests.helpers import scene_with


def anchor(name: str, relation: str) -> PlacementAnchor:
    return PlacementAnchor(target=Target(name=name), relation=relation)


# ---- Intent -> packet ------------------------------------------------------


def test_spawn_packet_keeps_the_anchor():
    (packet,) = AssetAnimator().build(
        Intent(action="spawn", primitive="box", anchor=anchor("PEDESTAL", "beside"))
    )
    assert packet.command == "SPAWN_OBJECT"
    assert packet.payload.anchor is not None
    assert packet.payload.anchor.target.name == "PEDESTAL"
    assert packet.payload.anchor.relation == "beside"


def test_spawn_anchor_travels_without_a_position():
    """The client's whole rule is anchor-outranks-position; a spawn that carries
    only the relation is the normal case, not a malformed one."""
    (packet,) = AssetAnimator().build(
        Intent(action="spawn", primitive="sphere", anchor=anchor("PEDESTAL", "on"))
    )
    assert packet.payload.position is None
    assert packet.payload.anchor.relation == "on"


def test_transform_packet_keeps_the_anchor():
    (packet,) = AssetAnimator().build(
        Intent(action="transform", target="SNEAKER", anchor=anchor("RUNNER", "beside")),
        scene_with("SNEAKER", "RUNNER"),
    )
    assert packet.command == "TRANSFORM_OBJECT"
    assert packet.payload.anchor is not None
    assert packet.payload.anchor.target.name == "RUNNER"
    assert packet.payload.anchor.relation == "beside"


def test_anchor_accepts_a_bare_name():
    """JSON-mode models write the name the prompt shows them. Dropping the whole
    intent over the nesting is the centre-stage spawn all over again."""
    intent = Intent.model_validate(
        {
            "action": "spawn",
            "primitive": "box",
            "anchor": {"target": "PEDESTAL", "relation": "on"},
        }
    )
    assert intent.anchor.target.name == "PEDESTAL"


# ---- grammar ---------------------------------------------------------------


def test_grammar_spawns_beside_a_named_object():
    scene = scene_with("CYLINDER_SPAWN")
    (i,) = parse("spawn a box beside the cylinder", scene)
    assert i.action == "spawn"
    assert i.primitive == "box"
    assert i.anchor is not None
    assert i.anchor.target.name == "CYLINDER_SPAWN"
    assert i.anchor.relation == "beside"


def test_grammar_puts_a_sphere_on_the_pedestal():
    scene = scene_with("PEDESTAL")
    (i,) = parse("put a sphere on the pedestal", scene)
    assert i.action == "spawn"
    assert i.primitive == "sphere"
    assert i.anchor.target.name == "PEDESTAL"
    assert i.anchor.relation == "on"


def test_grammar_reads_the_phrase_relations():
    scene = scene_with("PEDESTAL")
    for phrase, relation in (
        ("on top of the pedestal", "on"),
        ("above the pedestal", "above"),
        ("over the pedestal", "above"),
        ("next to the pedestal", "beside"),
        ("in front of the pedestal", "in_front_of"),
        ("behind the pedestal", "behind"),
        ("on the left of the pedestal", "left_of"),
        ("to the right of the pedestal", "right_of"),
    ):
        (i,) = parse(f"add a cone {phrase}", scene)
        assert i.anchor is not None, phrase
        assert i.anchor.relation == relation, phrase


def test_the_anchor_never_becomes_the_spawned_thing():
    """The primitive, colour, and name all come from the half of the clause
    before the relation — "a cylinder next to the box" is not a box."""
    scene = scene_with("BOX_MDL_01")
    (i,) = parse("spawn a red cylinder next to the blue box", scene)
    assert i.primitive == "cylinder"
    assert i.color == "#ff3b30"
    assert i.anchor.target.name == "BOX_MDL_01"


def test_grammar_anchors_a_pronoun_to_the_last_target():
    scene = scene_with("PEDESTAL")
    session_context.note_target("PEDESTAL")
    (i,) = parse("spawn a box beside it", scene)
    assert i.anchor is not None
    assert i.anchor.target.name == "PEDESTAL"


def test_grammar_anchors_without_a_snapshot():
    """Director Link still connecting: pass the bare noun through and let the
    client resolve it against the set it can actually see."""
    (i,) = parse("spawn a box beside the pedestal")
    assert i.anchor.target.name == "pedestal"
    assert i.anchor.relation == "beside"


def test_plain_spawn_still_has_no_anchor():
    (i,) = parse("add a red box")
    assert i.action == "spawn"
    assert i.anchor is None


def test_sign_copy_is_not_read_as_a_placement():
    scene = scene_with("PEDESTAL")
    (i,) = parse("add a sign saying 'on the pedestal'", scene)
    assert "on the pedestal" in i.text
    assert i.anchor is None


# ---- salvage (keyed path) --------------------------------------------------


async def test_salvage_fills_the_anchor_the_model_dropped(producer: Producer):
    """The model answered with a bare spawn — without this the box lands at
    stage centre even though the director named where it goes."""
    scene = scene_with("PEDESTAL")
    packets = await producer._build_packets_for_intent(
        Intent(action="spawn", primitive="box"),
        scene=scene,
        utterance="spawn a box beside the pedestal",
    )
    assert packets[0].payload.anchor is not None
    assert packets[0].payload.anchor.target.name == "PEDESTAL"
    assert packets[0].payload.anchor.relation == "beside"


async def test_salvage_put_a_cube_on_the_pedestal(producer: Producer):
    scene = scene_with("PEDESTAL")
    packets = await producer._build_packets_for_intent(
        Intent(action="spawn", primitive="box", color="#ff3b30"),
        scene=scene,
        utterance="put a red cube on the pedestal",
    )
    assert packets[0].payload.anchor is not None
    assert packets[0].payload.anchor.target.name == "PEDESTAL"
    assert packets[0].payload.anchor.relation == "on"


async def test_salvage_left_of_a_sphere(producer: Producer):
    scene = scene_with("CORE_SPHERE")
    packets = await producer._build_packets_for_intent(
        Intent(action="spawn", primitive="box"),
        scene=scene,
        utterance="place a box on the left of a sphere",
    )
    assert packets[0].payload.anchor is not None
    assert packets[0].payload.anchor.relation == "left_of"
    assert packets[0].payload.anchor.target.name == "CORE_SPHERE"


async def test_salvage_recovers_a_comma_split_destination(producer: Producer):
    """Spoken comma: 'put a red cube, on the pedestal' must not lose 'on'."""
    scene = scene_with("PEDESTAL")
    packets = await producer._build_packets_for_intent(
        Intent(action="spawn", primitive="box"),
        scene=scene,
        utterance="put a red cube, on the pedestal",
    )
    assert packets[0].payload.anchor is not None
    assert packets[0].payload.anchor.target.name == "PEDESTAL"
    assert packets[0].payload.anchor.relation == "on"


async def test_salvage_leaves_the_models_own_anchor_alone(producer: Producer):
    scene = scene_with("PEDESTAL", "CORE_SPHERE")
    packets = await producer._build_packets_for_intent(
        Intent(action="spawn", primitive="box", anchor=anchor("CORE_SPHERE", "above")),
        scene=scene,
        utterance="spawn a box beside the pedestal",
    )
    assert packets[0].payload.anchor.target.name == "CORE_SPHERE"
    assert packets[0].payload.anchor.relation == "above"


async def test_salvage_ignores_a_relation_word_from_another_clause(producer: Producer):
    """The "on" in "turn on the bloom" is not a placement, and it belongs to a
    clause that never asked for a box."""
    scene = scene_with("PEDESTAL")
    packets = await producer._build_packets_for_intent(
        Intent(action="spawn", primitive="box"),
        scene=scene,
        utterance="add a box and turn on the bloom",
    )
    assert packets[0].payload.anchor is None


async def test_salvage_keeps_a_placement_the_set_cannot_resolve(producer: Producer):
    """The snapshot lags the set, and the client resolves names against the live
    mesh anyway. Refusing to guess here is what leaves the prop centre stage —
    the grammar's own read is no longer applied to carry it."""
    packets = await producer._build_packets_for_intent(
        Intent(action="spawn", primitive="sphere"),
        scene=scene_with("SOMETHING_ELSE"),
        utterance="add a sphere beside the cube",
    )
    anchor_out = packets[0].payload.anchor
    assert anchor_out is not None
    assert anchor_out.target.name == "cube"
    assert anchor_out.relation == "beside"


async def test_salvage_stays_in_the_clause_that_asked_for_the_prop(producer: Producer):
    """The placement in the second clause belongs to the sneaker, not to a box
    spawned in the same breath."""
    scene = scene_with("PEDESTAL", "SNEAKER_ONE")
    packets = await producer._build_packets_for_intent(
        Intent(action="spawn", primitive="box"),
        scene=scene,
        utterance="add a box, then put the sneaker on the pedestal",
    )
    assert packets[0].payload.anchor is None


async def test_salvage_finds_the_spawn_clause_on_a_compound_line(producer: Producer):
    scene = scene_with("PEDESTAL")
    packets = await producer._build_packets_for_intent(
        Intent(action="spawn", primitive="cone"),
        scene=scene,
        utterance="dim the lights, then add a cone beside the pedestal",
    )
    assert packets[0].payload.anchor.target.name == "PEDESTAL"
    assert packets[0].payload.anchor.relation == "beside"


def test_salvage_needs_a_relation_word():
    assert find_placement_anchor("spawn a box", scene_with("PEDESTAL")) is None
