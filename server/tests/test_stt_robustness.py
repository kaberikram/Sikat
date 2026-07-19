"""Grammar robustness against real STT output — digits in names, word
numbers, substring targets, spurious take-cuts, and pronoun resolution."""
from app.clause_handlers import parse_clause
from app.session_context import SessionContext, bind_session, reset_session

from tests.helpers import scene_with


# ---- digits inside object names must not become magnitudes ----

def test_move_target_with_digit_in_name_moves_by_one():
    scene = scene_with("agent_2")
    intent = parse_clause("move agent_2 up", scene)
    assert intent is not None
    assert intent.action == "transform"
    assert intent.target == "agent_2"
    assert intent.position == (0.0, 1.0, 0.0)


def test_move_target_with_digit_still_takes_explicit_amount():
    scene = scene_with("agent_2")
    intent = parse_clause("move agent_2 up by 3", scene)
    assert intent is not None
    assert intent.position == (0.0, 3.0, 0.0)


def test_scale_target_with_digit_in_name_uses_default_factor():
    scene = scene_with("box_3")
    intent = parse_clause("make box_3 bigger", scene)
    assert intent is not None
    assert intent.action == "transform"
    assert intent.scale == (1.5, 1.5, 1.5)


# ---- word numbers from speech ----

def test_move_up_word_number():
    scene = scene_with("BOX")
    intent = parse_clause("move the box up two", scene)
    assert intent is not None
    assert intent.position == (0.0, 2.0, 0.0)


def test_scale_by_word_number():
    scene = scene_with("BOX")
    intent = parse_clause("scale the box by two", scene)
    assert intent is not None
    assert intent.scale == (2.0, 2.0, 2.0)


def test_pronoun_this_one_survives_normalization():
    scene = scene_with("BOX")
    # "this one" must stay a pronoun, not become "this 1".
    intent = parse_clause("move this one up", scene)
    # No prior addressed target in a fresh session context — the pronoun may
    # not resolve, but it must never crash or misparse into a magnitude.
    if intent is not None and intent.position is not None:
        assert intent.position[1] == 1.0


# ---- substring target matching ----

def test_short_name_does_not_match_inside_word():
    scene = scene_with("orb")
    intent = parse_clause("absorb the light please", scene)
    # "absorb" must not resolve target "orb" and turn this into a transform.
    assert intent is None or intent.target != "orb" or intent.action not in ("transform",)


def test_exact_name_still_matches():
    scene = scene_with("orb")
    intent = parse_clause("move the orb up", scene)
    assert intent is not None
    assert intent.target == "orb"


# ---- "cut" as a bare cue only ----

def _is_cut(intent):
    return (
        intent is not None
        and intent.action == "playback"
        and intent.playback_action == "cut"
    )


def test_bare_cut_ends_take():
    assert _is_cut(parse_clause("cut", None))


def test_and_cut_ends_take():
    assert _is_cut(parse_clause("and cut", None))


def test_thats_a_wrap_ends_take():
    assert _is_cut(parse_clause("that's a wrap", None))


def test_cut_the_bloom_does_not_end_take():
    intent = parse_clause("cut the bloom", None)
    assert not _is_cut(intent)


def test_haircut_does_not_end_take():
    intent = parse_clause("give it a haircut", None)
    assert not _is_cut(intent)


# ---- material/color commands must resolve pronouns, same as move ----

def test_material_pronoun_resolves_to_last_target():
    scene = scene_with("BOX_SPAWN")
    ctx = SessionContext()
    ctx.note_target("BOX_SPAWN")
    token = bind_session(ctx)
    try:
        intent = parse_clause("make it gold", scene)
        assert intent is not None
        assert intent.action == "set_material"
        assert intent.target == "BOX_SPAWN"
        assert intent.color == "#ffd700"
    finally:
        reset_session(token)


def test_material_without_pronoun_or_target_falls_through_to_spawn():
    # "make a blue cone" must still spawn when nothing named "cone" exists —
    # material parsing must not swallow it via a bare-primitive-word target.
    intent = parse_clause("make a blue cone", None)
    assert intent is not None
    assert intent.action == "spawn"
    assert intent.primitive == "cone"
