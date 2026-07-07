"""Grammar radio lines for instant-path cursor notes."""
from app.grammar_say import intent_with_radio, radio_line
from app.schema import Intent

from tests.helpers import scene_with


def test_spawn_red_box_radio():
    line = radio_line(Intent(action="spawn", primitive="box", color="#ff3b30"))
    assert "box" in line
    assert "red" in line
    assert line != "spawning"


def test_playback_cut_radio():
    assert radio_line(Intent(action="playback", playback_action="cut")) == "that's a cut"


def test_bloom_on_radio():
    line = radio_line(Intent(action="update_fx", section="bloom", fx_enabled=True))
    assert "bloom" in line.lower()


def test_bloom_off_radio():
    line = radio_line(Intent(action="update_fx", section="bloom", fx_enabled=False))
    assert "cutting" in line.lower()


def test_intent_with_radio_preserves_existing_say():
    intent = Intent(action="spawn", primitive="box", say="custom line")
    assert intent_with_radio(intent).say == "custom line"


async def test_instant_spawn_uses_radio_not_spawning(monkeypatch, scene):
    from app import llm
    from app.agents.producer import Producer

    stream_started = False

    async def slow_stream(text, scene, frame=None, on_partial=None, hints=None):
        nonlocal stream_started
        stream_started = True
        yield Intent(action="spawn", primitive="box")

    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(llm, "stream_intents", slow_stream)
    monkeypatch.setattr(llm, "select_provider", lambda frame=None: "deepseek")

    statuses: list[tuple[str, str, str | None]] = []

    async def emit_log(agent, message, level="info"):
        return None

    async def emit_packet(packet):
        return None

    async def emit_status(agent, status, command_id=None, note=None):
        statuses.append((agent, status, note))

    await Producer().direct(
        "add a red box",
        scene,
        "cmd-radio",
        emit_log,
        emit_packet,
        emit_status,
    )

    assert not stream_started
    active_notes = [note for _, status, note in statuses if status == "active" and note]
    assert active_notes
    assert active_notes[0] != "spawning"
    assert "box" in active_notes[0]
    assert "red" in active_notes[0]
