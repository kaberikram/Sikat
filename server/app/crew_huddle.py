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

HUDDLE_PROMPT = """You are {agent} on a film set. Rephrase this observation in ≤14 words, in-character.
Persona: {persona}
Observation: {template}
Scene context: {brief}
Return JSON only: {{"say": "...", "suggested_command": "{suggested_command}" or null}}"""


async def phrase_observation(
    obs: Observation,
    scene: SceneState | None,
    persona: str | None = None,
) -> dict[str, str | None]:
    """LLM polish or template fallback."""
    provider = llm.select_provider()
    if provider is None:
        return {"say": obs.template_line, "suggested_command": obs.suggested_command}

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
            say = (intent.say or intent.describe_message or obs.template_line)[:80]
            cmd = obs.suggested_command
            return {"say": say, "suggested_command": cmd}
    except (asyncio.TimeoutError, Exception) as exc:
        log.debug("crew huddle fallback: %s", exc)

    return {"say": obs.template_line, "suggested_command": obs.suggested_command}
