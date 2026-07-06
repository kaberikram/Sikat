"""Crew voice and persona tests (Phase C)."""
from app.heuristics import TEMPLATE_POOLS
from app.llm import _system_prompt
from app.performers import CREW_PERSONAS, crew_brief, crew_persona
from tests.helpers import scene_with


def test_crew_brief_lists_all_agents():
    brief = crew_brief()
    for agent in CREW_PERSONAS:
        assert agent in brief


def test_crew_brief_in_system_prompt():
    prompt = _system_prompt(scene_with("BOX"))
    assert "CREW VOICES" in prompt
    assert "AssetAnimator" in prompt


def test_template_pools_disjoint_per_agent():
    pools = list(TEMPLATE_POOLS.values())
    for i, a in enumerate(pools):
        for j, b in enumerate(pools):
            if i == j:
                continue
            assert not set(a) & set(b), "template pools should not overlap across agents"


def test_crew_persona_lookup():
    assert crew_persona("VFXOperator") == CREW_PERSONAS["VFXOperator"]
    assert crew_persona("Unknown") is None
