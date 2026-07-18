"""Point + speak: a physical aim (targetHint) resolves deictics outright."""
from app import session_context
from app.clause_handlers import parse_clause
from app.schema import Target, UserCommand
from app.session_context import SessionContext, bind_session, reset_session

from tests.helpers import scene_with


def test_user_command_accepts_target_hint():
    msg = UserCommand.model_validate({
        "type": "user_command",
        "text": "make this gold",
        "targetHint": {"id": "abc", "name": "SNEAKER_ONE"},
    })
    assert msg.targetHint is not None
    assert msg.targetHint.name == "SNEAKER_ONE"


def test_user_command_target_hint_optional():
    msg = UserCommand.model_validate({"type": "user_command", "text": "play"})
    assert msg.targetHint is None


def _with_pointed(name):
    ctx = SessionContext()
    ctx.set_pointed_target(name)
    return ctx


def test_pointed_target_resolves_pronoun_move():
    ctx = _with_pointed("BLUE_BOX")
    token = bind_session(ctx)
    try:
        scene = scene_with("RED_BOX", "BLUE_BOX")
        intent = parse_clause("move this up", scene)
        assert intent is not None
        assert intent.action == "transform"
        assert intent.target == "BLUE_BOX"
    finally:
        reset_session(token)


def test_pointed_target_beats_ambiguity_clarify():
    ctx = _with_pointed("BOX_B")
    token = bind_session(ctx)
    try:
        # Two identically-typed boxes would normally be ambiguous for "this".
        scene = scene_with("BOX_A", "BOX_B")
        intent = parse_clause("move that up", scene)
        assert intent is not None
        assert intent.action == "transform", intent
        assert intent.target == "BOX_B"
    finally:
        reset_session(token)


def test_no_point_keeps_normal_resolution():
    ctx = SessionContext()
    token = bind_session(ctx)
    try:
        scene = scene_with("RED_BOX")
        intent = parse_clause("move the red_box up", scene)
        assert intent is not None
        assert intent.target == "RED_BOX"
        assert session_context.pointed_target() is None
    finally:
        reset_session(token)


def test_pointed_target_cleared_scopes_to_command():
    ctx = _with_pointed("SNEAKER_ONE")
    ctx.set_pointed_target(None)
    token = bind_session(ctx)
    try:
        assert session_context.pointed_target() is None
        assert ctx.last_target() is None
    finally:
        reset_session(token)
