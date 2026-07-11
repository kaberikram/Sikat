"""Shine macro tests: offline fallback, seeded variation, and LLM-first routing."""
from __future__ import annotations

import pytest

from app import llm
from app.creative_parse import defer_clause_to_llm
from app.schema import Intent, PlanStep
from app.session_context import SessionContext, bind_session, reset_session
from app.shine_presets import shine_packets
from tests.helpers import animated_sphere_scene, scene_with


@pytest.fixture(autouse=True)
def _isolated_session():
    ctx = SessionContext()
    token = bind_session(ctx)
    yield
    reset_session(token)


@pytest.mark.parametrize("phrase", ["make it shine", "shine", "product showcase"])
async def test_shine_phrases_expand(producer, scene, phrase):
    packets, _ = await producer.handle_user_command(phrase, scene)
    commands = [p.command for p in packets]
    assert "UPDATE_LIGHTS" in commands
    assert "UPDATE_FX" in commands
    assert "MOVE_CAMERA" in commands
    assert commands.count("ANIMATE_OBJECT") >= 3
    assert commands[-1] == "PLAYBACK"


async def test_shine_uses_selected_hero_without_spawning_it(producer):
    scene = animated_sphere_scene()  # selectedId="id0", name="CORE_SPHERE"
    packets, _ = await producer.handle_user_command("make it shine", scene)
    spawn_names = [
        p.payload.name for p in packets if p.command == "SPAWN_OBJECT"
    ]
    assert spawn_names == ["SHINE_TITLE"]
    animate_targets = {
        p.payload.target.name for p in packets if p.command == "ANIMATE_OBJECT"
    }
    assert "CORE_SPHERE" in animate_targets
    camera = next(p for p in packets if p.command == "MOVE_CAMERA")
    assert camera.payload.lookAtTarget.name == "CORE_SPHERE"


async def test_shine_spawns_hero_sphere_when_none_exists(producer):
    empty_scene = scene_with()
    packets, _ = await producer.handle_user_command("make it shine", empty_scene)
    spawns = [p for p in packets if p.command == "SPAWN_OBJECT"]
    assert [p.payload.primitive for p in spawns] == ["sphere", "text"]
    assert spawns[1].payload.text == "RADIO_EDIT"


async def test_unknown_mood_still_returns_no_packets(producer, scene):
    packets, _ = await producer.handle_user_command("gothic atmosphere", scene)
    assert packets == []


async def test_showcase_anime_style_targets_named_sphere(producer):
    scene = scene_with("CORE_SPHERE")
    packets, _ = await producer.handle_user_command(
        "animate the sphere like a product showcase anime style", scene
    )
    commands = [p.command for p in packets]
    assert "UPDATE_LIGHTS" in commands
    assert "UPDATE_FX" in commands
    assert "MOVE_CAMERA" in commands
    assert commands.count("ANIMATE_OBJECT") >= 3
    assert commands[-1] == "PLAYBACK"
    spawn_names = [p.payload.name for p in packets if p.command == "SPAWN_OBJECT"]
    assert spawn_names == ["SHINE_TITLE"]
    animate_targets = {p.payload.target.name for p in packets if p.command == "ANIMATE_OBJECT"}
    assert "CORE_SPHERE" in animate_targets
    camera = next(p for p in packets if p.command == "MOVE_CAMERA")
    assert camera.payload.lookAtTarget.name == "CORE_SPHERE"


async def test_shine_the_blue_ball_targets_named_object(producer):
    scene = scene_with("BLUE_BALL")
    packets, _ = await producer.handle_user_command("shine the blue ball", scene)
    spawn_names = [p.payload.name for p in packets if p.command == "SPAWN_OBJECT"]
    assert spawn_names == ["SHINE_TITLE"]
    animate_targets = {p.payload.target.name for p in packets if p.command == "ANIMATE_OBJECT"}
    assert "BLUE_BALL" in animate_targets


async def test_hero_shot_of_the_sphere_fires_shine(producer):
    scene = scene_with("CORE_SPHERE")
    packets, _ = await producer.handle_user_command("hero shot of the sphere", scene)
    commands = [p.command for p in packets]
    assert "UPDATE_FX" in commands
    assert commands[-1] == "PLAYBACK"


async def test_dark_corner_phrase_does_not_fire_noir(producer, scene):
    # "dark" here is a lighting adjustment (_parse_lights legitimately fires),
    # not a noir mood pick — _parse_mood must not also claim this clause.
    from app.clause_handlers import _parse_mood

    assert _parse_mood("a dark corner of the box", scene, None) is None


def _dumps(packets):
    return [p.model_dump(exclude={"timestamp"}) for p in packets]


def test_shine_macro_varies_per_take(scene):
    """Different command ids → different camera/motion; the macro never replays verbatim."""
    base = _dumps(shine_packets(scene, command_id="take-1"))
    others = [
        _dumps(shine_packets(scene, command_id=cid)) for cid in ("take-2", "take-3", "take-4")
    ]
    assert any(other != base for other in others)


def test_shine_macro_repeatable_for_same_command(scene):
    a = _dumps(shine_packets(scene, command_id="same-take"))
    b = _dumps(shine_packets(scene, command_id="same-take"))
    assert a == b


def test_shine_variation_keeps_showcase_shape(scene):
    packets = shine_packets(scene, command_id="shape-check")
    commands = [p.command for p in packets]
    assert commands.count("ANIMATE_OBJECT") == 3
    assert commands[-1] == "PLAYBACK"
    camera = next(p for p in packets if p.command == "MOVE_CAMERA")
    assert camera.payload.lookAtTarget is not None
    spawns = [p for p in packets if p.command == "SPAWN_OBJECT"]
    assert spawns[-1].payload.text == "RADIO_EDIT"


def test_shine_defers_to_llm_when_available():
    intent = Intent(action="set_scene", mood="shine")
    assert defer_clause_to_llm("product showcase", intent, llm_available=True) is True
    assert defer_clause_to_llm("product showcase", intent, llm_available=False) is False


async def test_showcase_routes_to_plan_loop_when_llm_ready(monkeypatch, producer, scene):
    """With an LLM configured, "product showcase" is choreographed by the plan
    loop instead of instantly replaying the canned grammar macro."""
    plan_calls: list[str] = []

    async def scripted_plan(text, scene_arg, frame=None, *, tier="fast", extra_context=None, adjustment=False):
        plan_calls.append(text)
        if adjustment:
            return
        yield llm.Say("fresh showcase, take one")
        yield llm.Meta(mode="execute", needs_deeper_creativity=False)
        yield llm.Step(
            PlanStep.model_validate(
                {"action": "spawn", "primitive": "cone", "name": "LLM_HERO", "say": "hero in"}
            )
        )
        yield llm.Step(PlanStep.model_validate({"action": "playback", "playback_action": "play"}))

    monkeypatch.setattr(llm, "select_tier", lambda frame, *, escalated: ("deepseek", "test-model"))
    monkeypatch.setattr(llm, "stream_plan", scripted_plan)

    packets: list = []

    async def emit_packet(packet):
        packets.append(packet)

    await producer.direct("product showcase", scene, "cmd-showcase", emit_packet=emit_packet)

    assert plan_calls, "plan loop was not consulted — grammar macro took over"
    assert any(
        p.command == "SPAWN_OBJECT" and p.payload.name == "LLM_HERO" for p in packets
    )
    # The canned macro's title card must NOT have fired.
    assert not any(
        p.command == "SPAWN_OBJECT" and p.payload.name == "SHINE_TITLE" for p in packets
    )


async def test_showcase_keyless_still_fires_macro(producer, scene):
    """No LLM configured → deterministic macro fallback still delivers the beat."""
    packets, _ = await producer.direct("product showcase", scene, "cmd-offline")
    commands = [p.command for p in packets]
    assert "MOVE_CAMERA" in commands
    assert commands[-1] == "PLAYBACK"
    assert any(
        p.command == "SPAWN_OBJECT" and p.payload.name == "SHINE_TITLE" for p in packets
    )
