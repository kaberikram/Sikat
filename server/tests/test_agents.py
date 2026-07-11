"""Producer pipeline tests (fallback path only — no API key needed)."""
import pytest

from app.mood_presets import mood_packets


async def test_spawn_then_lights(producer, scene):
    packets, _ = await producer.handle_user_command(
        "add a red box then dim the lights", scene, command_id="cmd-1"
    )
    assert [p.command for p in packets] == ["SPAWN_OBJECT", "UPDATE_LIGHTS"]
    assert all(p.commandId == "cmd-1" for p in packets)
    assert packets[0].payload.color == "#ff3b30"
    assert packets[1].payload.ambient.intensity == 0.3


async def test_mood_macro_expands(producer, scene):
    packets, _ = await producer.handle_user_command("sunset mood", scene)
    commands = [p.command for p in packets]
    assert "UPDATE_LIGHTS" in commands
    assert "UPDATE_FX" in commands
    assert len(packets) >= 2


async def test_transform_carries_transition(producer, scene):
    packets, _ = await producer.handle_user_command(
        "move the box up 2 over 3 seconds", scene
    )
    (packet,) = packets
    assert packet.command == "TRANSFORM_OBJECT"
    assert packet.payload.target.name == "BOX_MDL_01"
    assert packet.transition.durationSec == 3.0


async def test_playback(producer, scene):
    packets, _ = await producer.handle_user_command("pause", scene)
    (packet,) = packets
    assert packet.command == "PLAYBACK"
    assert packet.payload.action == "pause"


async def test_fx_clamped_via_schema(producer, scene):
    packets, _ = await producer.handle_user_command(
        "set bloom strength to 99", scene
    )
    (packet,) = packets
    assert packet.command == "UPDATE_FX"
    assert packet.payload.patch.strength == 2.5  # clamped, not rejected


async def test_unparseable_yields_no_packets(producer, scene):
    """Legacy handle_user_command path — joke still empty (no soft-miss there)."""
    packets, describe_only = await producer.handle_user_command("tell me a joke", scene)
    assert packets == []
    assert describe_only is False


async def test_direct_unparseable_soft_miss(producer, scene):
    """Live direct() path soft-misses open/unparsed speech instead of hard error."""
    packets, describe_only = await producer.direct("tell me a joke", scene)
    assert packets == []
    assert describe_only is True


async def test_emit_log_called(producer, scene):
    logs: list[tuple[str, str, str]] = []

    async def emit(agent: str, message: str, level: str = "info") -> None:
        logs.append((agent, message, level))

    await producer.handle_user_command("add a sphere", scene, emit=emit)
    assert any(agent == "DirectorsAssistant" for agent, _, _ in logs)
    assert any(agent == "AssetAnimator" for agent, _, _ in logs)


@pytest.mark.parametrize(
    "phrase,mood",
    [
        ("noir mood", "noir"),
        ("sunset mood", "sunset"),
        ("neon vibe", "neon"),
        ("studio look", "studio"),
    ],
)
async def test_all_mood_macros(producer, scene, phrase, mood):
    packets, _ = await producer.handle_user_command(phrase, scene)
    commands = [p.command for p in packets]
    assert "UPDATE_LIGHTS" in commands
    assert any(p.command == "UPDATE_FX" for p in packets) or mood == "studio"
    assert len(packets) >= 2


async def test_unknown_mood_returns_no_packets(producer, scene):
    assert mood_packets("gothic") == []
    packets, _ = await producer.handle_user_command("gothic atmosphere", scene)
    assert packets == []


def test_track_property_defaults_to_position():
    from app.agents.asset_animator import AssetAnimator
    from app.schema import Intent, Keyframe

    intent = Intent(
        action="animate",
        target="CORE_SPHERE",
        track_keyframes=[
            Keyframe(time=0, value=(0.0, 0.0, 0.0)),
            Keyframe(time=1, value=(1.0, 1.0, 1.0)),
        ],
        # track_property intentionally omitted
    )
    animator = AssetAnimator()
    packets = animator.build(intent)
    assert len(packets) >= 2
    assert packets[0].command == "SET_KEYFRAMES"
    assert packets[0].payload.property == "position"


def test_camera_target_produces_null_target_keyframes():
    from app.agents.asset_animator import AssetAnimator
    from app.schema import Intent, Keyframe

    intent = Intent(
        action="animate",
        target="CAMERA",
        track_property="position",
        track_keyframes=[
            Keyframe(time=0, value=(0.0, 1.0, 0.0)),
            Keyframe(time=1, value=(5.0, 1.5, 3.0)),
        ],
    )
    animator = AssetAnimator()
    packets = animator.build(intent)
    assert len(packets) >= 2
    assert packets[0].command == "SET_KEYFRAMES"
    assert packets[0].payload.target is None


def test_virtual_camera_target_produces_null_target():
    from app.agents.asset_animator import AssetAnimator
    from app.schema import Intent, Keyframe

    intent = Intent(
        action="animate",
        target="VIRTUAL_CAMERA",
        track_property="position",
        track_keyframes=[
            Keyframe(time=0, value=(0.0, 1.0, 0.0)),
            Keyframe(time=1, value=(5.0, 1.5, 3.0)),
        ],
    )
    animator = AssetAnimator()
    packets = animator.build(intent)
    assert len(packets) >= 2
    assert packets[0].command == "SET_KEYFRAMES"
    assert packets[0].payload.target is None
