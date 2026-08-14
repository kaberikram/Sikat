"""Grammar radio lines for instant-path cursor notes."""
from app.grammar_say import intent_with_radio, radio_line
from app.schema import Intent, PlacementAnchor, Target

from tests.helpers import scene_with


def anchor(name: str, relation: str) -> PlacementAnchor:
    return PlacementAnchor(target=Target(name=name), relation=relation)


def test_spawn_red_box_radio():
    line = radio_line(Intent(action="spawn", primitive="box", color="#ff3b30"))
    assert "box" in line
    assert "red" in line
    assert line != "spawning"


def test_spawn_radio_names_the_placement():
    """"dead center" was hardcoded, so the crew narrated the one thing an
    anchored spawn is not doing."""
    line = radio_line(
        Intent(action="spawn", primitive="sphere", anchor=anchor("CUBE", "beside"))
    )
    assert "beside the cube" in line
    assert "dead center" not in line


def test_spawn_radio_still_says_centre_without_an_anchor():
    line = radio_line(Intent(action="spawn", primitive="sphere"))
    assert "dead center" in line


def test_spawn_radio_reads_underscored_relations():
    line = radio_line(
        Intent(action="spawn", primitive="cone", anchor=anchor("PEDESTAL", "in_front_of"))
    )
    assert "in front of the pedestal" in line


def test_transform_radio_names_the_destination():
    line = radio_line(
        Intent(action="transform", target="SNEAKER", anchor=anchor("RUNNER", "on"))
    )
    assert "on the runner" in line


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


async def test_keyless_spawn_uses_radio_not_spawning(monkeypatch, scene):
    """With no crew on the line the grammar is the voice, and it should sound
    like set radio rather than a debug log. (Keyed, the LLM writes its own say —
    see test_clause_routing.)"""
    from app import llm
    from app.agents.producer import Producer

    stream_started = False

    async def slow_stream(text, scene, frame=None, on_partial=None, hints=None, tier="quality"):
        nonlocal stream_started
        stream_started = True
        yield Intent(action="spawn", primitive="box")

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.delenv("DIRECTOR_LLM_PROVIDER", raising=False)
    monkeypatch.setattr(llm, "stream_intents", slow_stream)

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
