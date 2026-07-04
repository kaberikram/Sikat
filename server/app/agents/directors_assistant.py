"""Director's Assistant: raw text -> list of structured Intents.

LLM (structured outputs) when ANTHROPIC_API_KEY is set; deterministic rule
grammar otherwise or on any LLM failure.
"""
from __future__ import annotations

from .. import fallback_parser, llm
from ..schema import Intent, SceneFrame, SceneState


class DirectorsAssistant:
    name = "DirectorsAssistant"

    async def parse(
        self, text: str, scene: SceneState | None, frame: SceneFrame | None = None
    ) -> tuple[list[Intent], str]:
        """Returns (intents, source) where source is "llm" or "fallback"."""
        result = await llm.parse_intents(text, scene, frame)
        if result is not None and result.intents:
            return result.intents, "llm"
        return fallback_parser.parse(text, scene), "fallback"
