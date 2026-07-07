"""Unit tests for LLM vs grammar intent reconciliation."""
from app.reconcile import GrammarEmit, reconcile
from app.schema import Intent


def _spawn(primitive="sphere", color="#3366ff", name=None):
    return Intent(action="spawn", primitive=primitive, color=color, name=name)


def test_spawn_duplicate_same_params():
    grammar = [GrammarEmit(intent=_spawn())]
    llm = _spawn()
    verdict, match = reconcile(llm, grammar)
    assert verdict == "duplicate"
    assert match is not None
    assert grammar[0].matched


def test_spawn_color_mismatch_is_duplicate():
    grammar = [GrammarEmit(intent=_spawn(color="#3366ff"))]
    llm = _spawn(color="#ff0000")
    verdict, _ = reconcile(llm, grammar)
    assert verdict == "duplicate"


def test_spawn_primitive_mismatch_suppress():
    grammar = [GrammarEmit(intent=_spawn(primitive="sphere"))]
    llm = _spawn(primitive="box")
    verdict, _ = reconcile(llm, grammar)
    assert verdict == "suppress"


def test_animate_duplicate_same_motion():
    g = Intent(action="animate", target="BOX", motion="bounce", motion_params={"hops": 3})
    grammar = [GrammarEmit(intent=g)]
    llm = Intent(
        action="animate", target="BOX", motion="bounce", motion_params={"hops": 3}
    )
    verdict, _ = reconcile(llm, grammar)
    assert verdict == "duplicate"


def test_animate_refine_tweaked_params():
    g = Intent(action="animate", target="BOX", motion="bounce", motion_params={"hops": 3})
    grammar = [GrammarEmit(intent=g)]
    llm = Intent(
        action="animate", target="BOX", motion="bounce", motion_params={"hops": 8}
    )
    verdict, _ = reconcile(llm, grammar)
    assert verdict == "refine"


def test_animate_replace_motion_change():
    g = Intent(action="animate", target="BOX", motion="bounce")
    grammar = [GrammarEmit(intent=g)]
    llm = Intent(action="animate", target="BOX", motion="wander")
    verdict, _ = reconcile(llm, grammar)
    assert verdict == "replace"


def test_animate_replace_track_keyframes():
    g = Intent(action="animate", target="BOX", motion="bounce")
    grammar = [GrammarEmit(intent=g)]
    llm = Intent(
        action="animate",
        target="BOX",
        track_keyframes=[{"time": 0, "value": [0, 0, 0]}],
    )
    verdict, _ = reconcile(llm, grammar)
    assert verdict == "replace"


def test_transform_duplicate_within_tolerance():
    g = Intent(
        action="transform",
        target="BOX",
        mode="relative",
        position=(0, 1, 0),
    )
    grammar = [GrammarEmit(intent=g)]
    llm = Intent(
        action="transform",
        target="BOX",
        mode="relative",
        position=(0, 1.05, 0),
    )
    verdict, _ = reconcile(llm, grammar)
    assert verdict == "duplicate"


def test_playback_always_duplicate():
    g = Intent(action="playback", playback_action="play")
    grammar = [GrammarEmit(intent=g)]
    llm = Intent(action="playback", playback_action="play")
    verdict, _ = reconcile(llm, grammar)
    assert verdict == "duplicate"


def test_new_intent_no_grammar_match():
    grammar = [GrammarEmit(intent=_spawn())]
    llm = Intent(action="animate", target="BOX", motion="wander")
    verdict, match = reconcile(llm, grammar)
    assert verdict == "new"
    assert match is None


def test_greedy_consumption_two_animates():
    g1 = Intent(action="animate", target="A", motion="bounce")
    g2 = Intent(action="animate", target="B", motion="wander")
    grammar = [GrammarEmit(intent=g1), GrammarEmit(intent=g2)]
    llm_b = Intent(action="animate", target="B", motion="wander")
    verdict_b, _ = reconcile(llm_b, grammar)
    assert verdict_b == "duplicate"
    assert grammar[0].matched is False
    assert grammar[1].matched is True
