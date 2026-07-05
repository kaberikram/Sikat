# Task Board

Kanban-style (works with the Obsidian Kanban plugin — one list per heading).

## Done

- [x] Contract first: `schema.py` + `protocol.ts` + [[Command_Protocol]]
- [x] Server skeleton: `main.py`, ConnectionManager, fallback parser, pytest green
- [x] Frontend socket + DirectorConsole mounted in viewport
- [x] Store extensions (lighting, materials, id-honoring addObject) + command applier + tween + spawn factory
- [x] Agent layer: Producer routing, specialists, `llm.py` Anthropic path
- [x] scene-state sync, telemetry pipeline, `mock_telemetry.py`, voice button
- [x] Docs vault + README Director Mode section
- [x] "Thinking crew" pass (visual affirmation, latency telemetry, streaming
      LLM parse, in-character `say` chatter, per-performer memory, barge-in
      v1) — see [[Roadmap]] for detail

## In progress

- [ ] [[Scene_Aware_Director]] Phase A — rich scene context + describe intent + LLM prompt

## Backlog (Scene-Aware Director)

- [x] ~~Phase C — set radio verbal ACKs (`set-radio.ts`)~~ superseded: removed
      entirely, visual affirmation only (bled into the director's own mic input)
- [ ] Phase B — viewfinder capture + vision triggers
- [ ] Phase D — hold / action / cut
- [x] Phase E — streaming partial intents

## Backlog (other)

- [ ] Phase 4: scripted shoot + synchronized playback log
- [ ] WebXR telemetry source (replace mock with headset pose)
- [ ] Include `lighting` + `materialOverride` in EXPORT_JSON
- [ ] Vitest coverage for command-applier edge cases (tween-vs-keyframe policy)
- [ ] Multi-client sanity pass (two browsers, one server)
