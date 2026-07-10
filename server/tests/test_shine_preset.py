"""Shine v1 macro tests (fallback/grammar path only — no API key needed)."""
from __future__ import annotations

import pytest

from app.session_context import SessionContext, bind_session, reset_session
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
