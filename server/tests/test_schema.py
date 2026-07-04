"""Wire-contract tests: packet round-trips, clamping, discriminated unions."""
import pytest
from pydantic import ValidationError

from app.schema import (
    SceneState,
    Target,
    Telemetry,
    UpdateFxPacket,
    UpdateLightsPayload,
    UserCommand,
    client_message_adapter,
    command_packet_adapter,
)


def test_command_packet_round_trip():
    raw = {
        "timestamp": 1751437200.5,
        "target_agent": "LightingTech",
        "command": "UPDATE_LIGHTS",
        "commandId": "abc-123",
        "payload": {"ambient": {"color": "#00ffff", "intensity": 1.2}},
        "transition": {"durationSec": 1.2, "easing": "easeOut"},
    }
    packet = command_packet_adapter.validate_python(raw)
    assert packet.command == "UPDATE_LIGHTS"
    assert packet.payload.ambient.color == "#00ffff"
    dumped = packet.model_dump()
    assert dumped["transition"]["easing"] == "easeOut"
    # survives a re-parse of its own dump
    again = command_packet_adapter.validate_python(dumped)
    assert again == packet


def test_fx_values_clamp_to_editor_slider_ranges():
    packet = UpdateFxPacket(
        payload={"section": "bloom", "patch": {"strength": 99.0, "threshold": -3}}
    )
    assert packet.payload.patch.strength == 2.5
    assert packet.payload.patch.threshold == 0.0


def test_light_intensity_clamps():
    payload = UpdateLightsPayload.model_validate({"key": {"intensity": 100}})
    assert payload.key.intensity == 8.0


def test_unknown_command_rejected():
    with pytest.raises(ValidationError):
        command_packet_adapter.validate_python(
            {"command": "SELF_DESTRUCT", "payload": {}}
        )


def test_target_requires_id_or_name():
    with pytest.raises(ValidationError):
        Target()
    assert Target(name="box").name == "box"


def test_client_message_discrimination():
    cmd = client_message_adapter.validate_python(
        {"type": "user_command", "text": "add a red box"}
    )
    assert isinstance(cmd, UserCommand)

    scene = client_message_adapter.validate_python(
        {
            "type": "scene_state",
            "objects": [{"id": "x1", "name": "CORE_SPHERE"}],
            "virtualCamera": {"position": [0, 1, 6], "rotation": [0, 0, 0], "fov": 50},
            "lighting": {
                "ambient": {"color": "#ffffff", "intensity": 0.8},
                "key": {"color": "#ffffff", "intensity": 1.5, "position": [5, 10, 7]},
                "background": "#f2f2f2",
            },
        }
    )
    assert isinstance(scene, SceneState)
    assert scene.objects[0].name == "CORE_SPHERE"

    tel = client_message_adapter.validate_python(
        {"type": "telemetry", "pose": {"position": [1, 2, 3]}}
    )
    assert isinstance(tel, Telemetry)


def test_empty_user_command_rejected():
    with pytest.raises(ValidationError):
        client_message_adapter.validate_python({"type": "user_command", "text": ""})
