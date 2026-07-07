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

- [x] WebXR passthrough camcorder v1 — `ENTER XR` in editor, right-grip tracked virtual camera, RT viewfinder on rig, trigger record/cut

## Backlog (WebXR follow-ups)

- [ ] WebXR telemetry sender-exclusion + headset pose → server
- [ ] FX-on-RT composer for camcorder screen
- [ ] Hand-tracking grab

## Backlog (Scene-Aware Director)

- [x] ~~Phase C — set radio verbal ACKs (`set-radio.ts`)~~ superseded: removed
      entirely, visual affirmation only (bled into the director's own mic input)
- [ ] Phase B — viewfinder capture + vision triggers
- [ ] Phase D — hold / action / cut
- [x] Phase E — streaming partial intents

## Backlog (other)

- [ ] Phase 4: scripted shoot + synchronized playback log
- [ ] WebXR telemetry sender-exclusion (server) + headset → MOVE_CAMERA wire path
- [ ] XR viewfinder FX composer on render target
- [ ] Include `lighting` + `materialOverride` in EXPORT_JSON
- [ ] Vitest coverage for command-applier edge cases (tween-vs-keyframe policy)
- [ ] Multi-client sanity pass (two browsers, one server)
