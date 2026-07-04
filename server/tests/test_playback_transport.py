"""Phase D: hold / action / cut film-set transport semantics."""
from app.agents.producer import Producer
from app.fallback_parser import parse


def test_cut_pauses():
    (i,) = parse("cut")
    assert i.action == "playback"
    assert i.playback_action == "pause"


def test_action_plays():
    (i,) = parse("action")
    assert i.playback_action == "play"


def test_go_plays():
    (i,) = parse("go")
    assert i.playback_action == "play"


def test_hold_freeze_stop_pause():
    for phrase in ("hold", "freeze", "stop"):
        (i,) = parse(phrase)
        assert i.playback_action == "pause", phrase


def test_back_to_one_sets_pause_after_seek():
    (i,) = parse("back to one")
    assert i.playback_action == "seek"
    assert i.seek_time == 0
    assert i.playback_pause_after_seek is True


def test_top_of_scene_sets_pause_after_seek():
    (i,) = parse("top of scene")
    assert i.playback_pause_after_seek is True


def test_rewind_seek_only_no_pause():
    (i,) = parse("rewind")
    assert i.playback_action == "seek"
    assert i.seek_time == 0
    assert not i.playback_pause_after_seek


def test_print_the_take_describe_only():
    intents = parse("print the take")
    assert len(intents) == 1
    assert intents[0].action == "describe"


async def test_producer_back_to_one_emits_seek_then_pause(producer: Producer):
    packets, _ = await producer.handle_user_command("back to one", None)
    assert len(packets) == 2
    assert packets[0].command == "PLAYBACK"
    assert packets[0].payload.action == "seek"
    assert packets[0].payload.time == 0
    assert packets[1].payload.action == "pause"


async def test_producer_cut_single_pause(producer: Producer):
    packets, _ = await producer.handle_user_command("cut", None)
    assert len(packets) == 1
    assert packets[0].payload.action == "pause"


async def test_producer_action_single_play(producer: Producer):
    packets, _ = await producer.handle_user_command("action", None)
    assert len(packets) == 1
    assert packets[0].payload.action == "play"
