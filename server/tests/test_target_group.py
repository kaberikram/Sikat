"""Directing more than one object at a time.

The bug these pin down: with three spheres on set, "put all 3 spheres on the
pedestal" spawned a fourth sphere. Every layer had its own share of it — the
plural never scored against a name, there was no way to say "all of them", the
prompts' only placement example was a spawn, and `put the X` was rewritten to
`add a X` before anything looked at the scene.
"""
from __future__ import annotations

import pytest

from app.agents.producer import AmbiguousTarget, Producer
from app.fallback_parser import parse
from app.outcome import summarize
from app.schema import (
    BoundsSnapshot,
    Intent,
    ObjectSnapshot,
    SampledTransform,
    SceneState,
)
from app.session_context import SessionContext, bind_session, reset_session
from app.spatial import Box, arrange_on
from app.target_resolution import (
    rank_targets,
    resolve_target_group,
    resolve_target_or_group,
)


def _obj(name: str, primitive: str, y: float = 0.0, radius: float = 0.08):
    return ObjectSnapshot(
        id=name.lower(),
        name=name,
        primitive=primitive,
        position=(0.0, y, 0.0),
        bounds=BoundsSnapshot(
            min=(-radius, y - radius, -radius), max=(radius, y + radius, radius)
        ),
        sampled=SampledTransform(
            position=(0.0, y, 0.0), rotation=(0.0, 0.0, 0.0), scale=(1.0, 1.0, 1.0)
        ),
    )


SPHERES = ["SPHERE_SPAWN", "SPHERE_SPAWN_2", "SPHERE_SPAWN_3"]


@pytest.fixture
def three_spheres() -> SceneState:
    return SceneState(
        objects=[
            _obj("SPHERE_SPAWN", "sphere", 0.6),
            _obj("SPHERE_SPAWN_2", "sphere", 0.6),
            _obj("SPHERE_SPAWN_3", "sphere", 0.6),
            _obj("PEDESTAL", "cylinder", 0.2, radius=0.30),
        ]
    )


@pytest.fixture
def session(three_spheres):
    ctx = SessionContext()
    ctx.latest_scene = three_spheres
    token = bind_session(ctx)
    yield ctx
    reset_session(token)


# ---------------------------------------------------------------------------
# resolution
# ---------------------------------------------------------------------------


def test_plural_scores_against_singular_name(three_spheres):
    """The original miss: "spheres" ranked nothing, so the referent vanished."""
    assert [name for name, _ in rank_targets("spheres", three_spheres)] == SPHERES


@pytest.mark.parametrize(
    "phrase",
    ["all 3 spheres", "the spheres", "all the balls", "both spheres", "every sphere"],
)
def test_group_phrases_gather_every_sphere(phrase, three_spheres):
    assert resolve_target_group(phrase, three_spheres) == SPHERES


def test_group_leaves_the_pedestal_out(three_spheres):
    assert "PEDESTAL" not in resolve_target_group("the spheres", three_spheres)


def test_singular_phrase_is_not_a_group(three_spheres):
    assert resolve_target_group("the sphere", three_spheres) == []


def test_them_means_the_last_group(three_spheres):
    assert resolve_target_group(
        "them", three_spheres, last_group=["SPHERE_SPAWN", "SPHERE_SPAWN_2"]
    ) == ["SPHERE_SPAWN", "SPHERE_SPAWN_2"]


def test_them_drops_members_that_left_the_set(three_spheres):
    assert resolve_target_group(
        "them", three_spheres, last_group=["SPHERE_SPAWN", "SPHERE_SPAWN_2", "GONE"]
    ) == ["SPHERE_SPAWN", "SPHERE_SPAWN_2"]


def test_exact_name_beats_the_plural_reading(three_spheres):
    resolution = resolve_target_or_group("SPHERE_SPAWN", three_spheres)
    assert resolution.reason == "exact"
    assert resolution.names == ["SPHERE_SPAWN"]


def test_singular_with_three_candidates_is_a_question(three_spheres):
    resolution = resolve_target_or_group("sphere", three_spheres)
    assert resolution.reason == "ambiguous"
    assert resolution.options == SPHERES


def test_unmatched_name_resolves_to_nothing(three_spheres):
    assert resolve_target_or_group("thingamajig", three_spheres).reason == "none"


# ---------------------------------------------------------------------------
# fan-out
# ---------------------------------------------------------------------------


async def test_put_all_three_moves_them_and_spawns_nothing(session, three_spheres):
    packets = await Producer()._build_packets_for_intent(
        Intent(
            action="transform",
            targets=SPHERES,
            anchor_target="PEDESTAL",
            anchor_relation="on",
        ),
        scene=three_spheres,
        utterance="put all 3 spheres on the pedestal",
    )
    assert [p.command for p in packets] == ["TRANSFORM_OBJECT"] * 3
    assert [p.payload.target.name for p in packets] == SPHERES
    assert all(p.payload.anchor.relation == "on" for p in packets)
    assert all(p.payload.anchor.target.name == "PEDESTAL" for p in packets)


async def test_group_members_do_not_land_on_the_same_spot(session, three_spheres):
    packets = await Producer()._build_packets_for_intent(
        Intent(
            action="transform",
            targets=SPHERES,
            anchor_target="PEDESTAL",
            anchor_relation="on",
        ),
        scene=three_spheres,
    )
    offsets = [p.payload.anchor.offset for p in packets]
    assert all(o is not None for o in offsets)
    assert len(set(offsets)) == 3


async def test_plural_phrase_in_target_fans_out(session, three_spheres):
    packets = await Producer()._build_packets_for_intent(
        Intent(action="set_material", target="the spheres", color="#ff3b30"),
        scene=three_spheres,
    )
    assert [p.payload.target.name for p in packets] == SPHERES
    assert all(p.payload.color == "#ff3b30" for p in packets)


async def test_group_is_remembered_for_the_next_them(session, three_spheres):
    producer = Producer()
    await producer._build_packets_for_intent(
        Intent(action="set_material", target="the spheres", color="#ff3b30"),
        scene=three_spheres,
    )
    packets = await producer._build_packets_for_intent(
        Intent(action="animate", target="them", motion="bounce"),
        scene=three_spheres,
    )
    assert [p.payload.target.name for p in packets] == SPHERES


async def test_names_the_set_does_not_have_are_dropped_not_invented(
    session, three_spheres
):
    packets = await Producer()._build_packets_for_intent(
        Intent(action="animate", targets=["SPHERE_SPAWN", "NOPE_1", "NOPE_2"], motion="bounce"),
        scene=three_spheres,
    )
    assert [p.payload.target.name for p in packets] == ["SPHERE_SPAWN"]
    assert session.unresolved_targets == ["NOPE_1", "NOPE_2"]


async def test_ambiguous_singular_asks_instead_of_guessing(session, three_spheres):
    with pytest.raises(AmbiguousTarget) as raised:
        await Producer()._build_packets_for_intent(
            Intent(action="transform", target="sphere", position=(0.0, 1.0, 0.0)),
            scene=three_spheres,
        )
    assert raised.value.options == SPHERES


async def test_an_answered_clarify_is_not_asked_again(session, three_spheres):
    session.set_clarify_target("SPHERE_SPAWN_2")
    packets = await Producer()._build_packets_for_intent(
        Intent(action="transform", target="sphere", position=(0.0, 1.0, 0.0)),
        scene=three_spheres,
    )
    assert [p.payload.target.name for p in packets] == ["SPHERE_SPAWN_2"]


# ---------------------------------------------------------------------------
# grammar (the keyless path, and the hints the LLM reads)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "line",
    [
        "put all 3 spheres on the pedestal",
        "put the spheres on the pedestal",
        "move the spheres onto the pedestal",
        "stack the spheres on the pedestal",
    ],
)
def test_grammar_moves_the_group_rather_than_spawning(line, session, three_spheres):
    intents = parse(line, three_spheres)
    assert [i.action for i in intents] == ["transform"]
    assert intents[0].targets == SPHERES
    assert intents[0].anchor.relation == "on"
    assert intents[0].anchor.target.name == "PEDESTAL"


def test_grammar_widens_a_follow_up_to_the_last_group(session, three_spheres):
    """"make them all red" after a group command means the same three."""
    session.note_group(SPHERES)
    session.note_target("SPHERE_SPAWN")
    intents = parse("make them all red", three_spheres)
    assert [i.action for i in intents] == ["set_material"]
    assert intents[0].targets == SPHERES
    assert intents[0].color == "#ff3b30"


def test_grammar_leaves_a_singular_direction_alone(session, three_spheres):
    session.note_group(SPHERES)
    intents = parse("make SPHERE_SPAWN_2 red", three_spheres)
    assert intents[0].targets == ["SPHERE_SPAWN_2"]


def test_grammar_asks_which_sphere_when_one_is_named(session, three_spheres):
    intents = parse("put the sphere on the pedestal", three_spheres)
    assert [i.action for i in intents] == ["clarify"]
    assert intents[0].clarify_options == SPHERES


@pytest.mark.parametrize(
    "line", ["add another sphere", "put a new sphere on the pedestal"]
)
def test_asking_for_another_one_still_spawns(line, session, three_spheres):
    intents = parse(line, three_spheres)
    assert [i.action for i in intents] == ["spawn"]
    assert intents[0].primitive == "sphere"


def test_put_a_prop_the_set_lacks_still_spawns(session):
    empty = SceneState(objects=[_obj("PEDESTAL", "cylinder", 0.2, radius=0.30)])
    intents = parse("put a sphere on the pedestal", empty)
    assert [i.action for i in intents] == ["spawn"]
    assert intents[0].anchor.target.name == "PEDESTAL"


# ---------------------------------------------------------------------------
# arrangement + the outcome line
# ---------------------------------------------------------------------------


def test_arrange_on_spreads_a_pair_along_the_longer_axis():
    anchor = Box(min=(-0.5, 0.0, -0.1), max=(0.5, 0.2, 0.1))
    movers = [Box(min=(-0.05, 0, -0.05), max=(0.05, 0.1, 0.05))] * 2
    offsets = arrange_on(anchor, movers)
    assert offsets[0][0] == -offsets[1][0]
    assert offsets[0][2] == offsets[1][2] == 0.0


def test_arrange_on_keeps_a_ring_inside_the_surface():
    anchor = Box(min=(-0.3, 0.0, -0.3), max=(0.3, 0.2, 0.3))
    movers = [Box(min=(-0.05, 0, -0.05), max=(0.05, 0.1, 0.05))] * 4
    for x, y, z in arrange_on(anchor, movers):
        assert y == 0.0
        assert (x**2 + z**2) ** 0.5 <= 0.3


def test_arrange_on_leaves_a_single_prop_centred():
    anchor = Box(min=(-0.3, 0.0, -0.3), max=(0.3, 0.2, 0.3))
    assert arrange_on(anchor, [None]) == [(0.0, 0.0, 0.0)]


async def test_outcome_names_what_moved_and_where(session, three_spheres):
    packets = await Producer()._build_packets_for_intent(
        Intent(
            action="transform",
            targets=SPHERES,
            anchor_target="PEDESTAL",
            anchor_relation="on",
        ),
        scene=three_spheres,
    )
    assert summarize(packets) == (
        "moved SPHERE_SPAWN, SPHERE_SPAWN_2 and SPHERE_SPAWN_3 onto PEDESTAL"
    )


async def test_outcome_says_what_was_missing(session, three_spheres):
    packets = await Producer()._build_packets_for_intent(
        Intent(
            action="transform",
            targets=["SPHERE_SPAWN", "SPHERE_SPAWN_2", "GONE"],
            anchor_target="PEDESTAL",
            anchor_relation="on",
        ),
        scene=three_spheres,
    )
    assert summarize(packets, unresolved=session.unresolved_targets) == (
        "moved SPHERE_SPAWN and SPHERE_SPAWN_2 onto PEDESTAL — GONE not on set"
    )


async def test_outcome_stays_quiet_when_the_set_already_answered(
    session, three_spheres
):
    """One prop, no placement: the prop moving is the acknowledgement."""
    packets = await Producer()._build_packets_for_intent(
        Intent(action="animate", target="SPHERE_SPAWN", motion="bounce"),
        scene=three_spheres,
    )
    assert packets
    assert summarize(packets) is None
