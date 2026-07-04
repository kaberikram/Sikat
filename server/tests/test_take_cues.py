"""Take record/cut cue parsing (fallback path, no API key)."""
from app.fallback_parser import parse


def test_and_action_records():
    (i,) = parse("and action")
    assert i.playback_action == "record"


def test_action_records():
    (i,) = parse("action")
    assert i.playback_action == "record"


def test_camera_rolling_records():
    for phrase in ("camera rolling", "camera's rolling", "cameras rolling"):
        intents = parse(phrase)
        assert len(intents) == 1, phrase
        assert intents[0].playback_action == "record", phrase


def test_start_recording_records():
    (i,) = parse("start recording")
    assert i.playback_action == "record"


def test_were_rolling_records():
    (i,) = parse("we're rolling")
    assert i.playback_action == "record"


def test_roll_camera_records():
    for phrase in ("roll camera", "roll sound", "roll it"):
        (i,) = parse(phrase)
        assert i.playback_action == "record", phrase


def test_cut_ends_take():
    (i,) = parse("cut")
    assert i.playback_action == "cut"


def test_thats_a_cut():
    (i,) = parse("that's a cut")
    assert i.playback_action == "cut"


def test_stop_recording_cut():
    (i,) = parse("stop recording")
    assert i.playback_action == "cut"


def test_plain_play_unchanged():
    (i,) = parse("play")
    assert i.playback_action == "play"


def test_go_still_plays():
    (i,) = parse("go")
    assert i.playback_action == "play"


def test_hold_still_pauses():
    (i,) = parse("hold")
    assert i.playback_action == "pause"
