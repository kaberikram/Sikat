# Director's Assistant

**Code:** `server/app/agents/directors_assistant.py`, `server/app/llm.py`,
`server/app/fallback_parser.py` · **Kind:** the only LLM-touching agent

## Role

Turns raw director speech/text into a list of structured `Intent`s. Two paths:

1. **LLM** — when `ANTHROPIC_API_KEY` is set: `client.messages.parse()` with
   `output_format=IntentList` (structured outputs guarantee schema-valid JSON).
   Model: `DIRECTOR_MODEL` env var, default `claude-sonnet-5`.
2. **Fallback** — the deterministic grammar in [[Fallback_Grammar]]; also the
   automatic safety net for any LLM exception or validation failure, so a broken
   key degrades the vocabulary, never the system.

## System prompt (actual text, abridged — full string in `llm.py`)

> You are the Director's Assistant for a virtual film studio. Parse the director's
> spoken instruction into a list of structured intents. …
> Rules: rotations are world-space euler XYZ in RADIANS; colors are lowercase
> "#rrggbb" hex; durations like "over 3 seconds" go into transition.durationSec;
> prefer set_scene for whole-mood requests; target must be one of the scene object
> names below when the director refers to an existing object.
> Current scene objects: *(injected from the latest scene_state snapshot)*

## Context isolation

The prompt contains only: the intent vocabulary, unit rules, current object
names/ids and camera fov. No conversation history, no other agents' outputs —
this is what keeps the parse deterministic-ish and prevents hallucinated targets.

## Failure modes

- LLM returns intents referencing nonexistent objects → applier's target
  resolution fails client-side; the console logs `target not found`.
- Empty parse (both paths) → Producer emits an `error` for the command.
