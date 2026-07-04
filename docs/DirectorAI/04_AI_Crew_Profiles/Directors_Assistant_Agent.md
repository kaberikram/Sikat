# Director's Assistant

**Code:** `server/app/agents/directors_assistant.py`, `server/app/llm.py`,
`server/app/fallback_parser.py`, `server/app/scene_context.py` · **Kind:** the only LLM-touching agent

## Role

Turns raw director speech/text into a list of structured `Intent`s. Two paths:

1. **LLM** — when an API key is set: structured JSON parse (Anthropic native or
   DeepSeek JSON mode). Model: `DIRECTOR_MODEL` env var.
2. **Fallback** — the deterministic grammar in [[Fallback_Grammar]]; also the
   automatic safety net for any LLM exception or validation failure.

## System prompt (Scene-Aware — full text in `llm.py` + [[LLM_System_Prompt]])

> You are the Director's Assistant on a virtual film set. Parse instructions into
> structured intents. You receive a **scene briefing** (not raw JSON) with BASE
> transforms, NOW/sampled poses at the playhead, keyframe track summaries, lighting,
> and viewfinder FX.
>
> Actions include `describe` for questions-only ("how's the bounce") — set
> `describe_topic` and `describe_message`; the Producer logs the message with zero
> command packets.
>
> Rules: rotations in RADIANS; colors `#rrggbb`; pronouns → history or `selectedId`;
> NOW vs BASE for motion vs placement.

## Context isolation

The prompt contains: intent vocabulary, unit rules, **scene briefing** from
`format_scene_brief(scene)`, and recent direction history. No other agents' outputs.

Scene source priority: embedded `user_command.scene` (full) overrides the debounced
heartbeat in `scene_state.latest()`.

## Failure modes

- LLM returns intents referencing nonexistent objects → applier's target
  resolution fails client-side; the console logs `target not found`.
- Empty parse (both paths) → Producer emits an `error` for the command.
- Describe-only parse → `agent_log` with `describe_message`, no error.
