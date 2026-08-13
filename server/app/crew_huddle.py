"""One-shot LLM phrasing for proactive crew observations."""
from __future__ import annotations

import asyncio
import logging

from . import llm
from .performers import crew_persona
from .heuristics import Observation
from .schema import SceneState

log = logging.getLogger("director.crew_huddle")

HUDDLE_TIMEOUT_SEC = 4.0

HUDDLE_PROMPT = """You are {agent} on this set. Offer ONE situated suggestion for THIS scene, ≤14 words, or stay silent.
Persona: {persona}
Internal detector cue (do not quote; never reuse stock lines like "BOX off stage"): {template}
Scene: {brief}
Return JSON only: {{"say": "<live suggestion or empty>", "suggested_command": "{suggested_command}" or null}}
If nothing specific to this scene is worth saying, return say as an empty string.
"""


async def phrase_observation(
    obs: Observation,
    scene: SceneState | None,
    persona: str | None = None,
) -> dict[str, str | None]:
    """Live suggestion from this scene, or silence. Never a template-pool line."""
    provider = llm.select_provider()
    if provider is None:
        return {"say": None, "suggested_command": None}

    brief = ""
    if scene is not None:
        from .scene_context import format_scene_brief

        brief = format_scene_brief(scene)[:400]

    persona_str = persona or crew_persona(obs.agent) or "laconic, professional"
    suggested = obs.suggested_command or "null"
    prompt = HUDDLE_PROMPT.format(
        agent=obs.agent,
        persona=persona_str,
        template=obs.template_line,
        brief=brief,
        suggested_command=suggested,
    )

    try:
        result = await asyncio.wait_for(
            llm.parse_intents(prompt, scene or SceneState()),
            timeout=HUDDLE_TIMEOUT_SEC,
        )
        if result and result.intents:
            intent = result.intents[0]
            raw = (intent.say or intent.describe_message or "").strip()
            if raw:
                return {
                    "say": raw[:80],
                    "suggested_command": obs.suggested_command,
                }
    except (asyncio.TimeoutError, Exception) as exc:
        log.debug("crew huddle silent: %s", exc)

    return {"say": None, "suggested_command": None}
