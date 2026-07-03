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

## In progress

## Backlog

- [ ] Phase 4: scripted shoot + synchronized playback log
- [ ] WebXR telemetry source (replace mock with headset pose)
- [ ] Include `lighting` + `materialOverride` in EXPORT_JSON
- [ ] Vitest coverage for command-applier edge cases (tween-vs-keyframe policy)
- [ ] Multi-client sanity pass (two browsers, one server)
