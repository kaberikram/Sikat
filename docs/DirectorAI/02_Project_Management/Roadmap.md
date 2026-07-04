# Roadmap

## Shipped — Scene-Aware Director (Phases A–E)

Phased brief: `06_Implementation_Brief/Scene_Aware_Director.md`. All phases complete:

- [x] **Phase A** — Rich scene context (heartbeat + full snapshot, sampled poses, `describe` intent)
- [x] **Phase C** — Set radio (browser TTS ACKs on agent active)
- [x] **Phase B** — Vision on command (viewfinder JPEG; Anthropic multimodal)
- [x] **Phase D** — Hold / Action / Cut (playback transport semantics)
- [x] **Phase E** — Streaming partial intents (per-clause emit; LLM in parallel)

Hybrid LLM routing: DeepSeek for text-only, Anthropic when viewfinder JPEG attached.

## Shipped — Phase 2+3 of the PRD (this branch)

The core loop: **text/voice command → agent swarm → JSON over WebSocket → live scene mutation.**

- [x] Wire contract (pydantic + TS mirror), values clamped to editor slider ranges
- [x] FastAPI WebSocket server, multicast ConnectionManager, `/healthz`
- [x] Agent crew: Producer, Director's Assistant (LLM + fallback), Lighting Tech, Asset Animator, VFX Operator
- [x] Anthropic structured-outputs parse path (`ANTHROPIC_API_KEY`), deterministic rule grammar otherwise
- [x] DirectorConsole UI (status, agent log, text input, Chromium voice input)
- [x] Command applier: store-writes only; tween engine; keyframe-baking policy for keyframed properties
- [x] Store lighting slice + `setObjectMaterial`; Scene reads lighting per frame
- [x] Scene-state sync (debounced snapshots up), telemetry → MOVE_CAMERA (mock orbit script)
- [x] pytest suite (35 tests) + browser E2E verified

## Explicitly OUT of scope (PRD Phase 4)

- Scripted shoot sequence ("Set scene" / "Action" / "Cut" as one verbal program)
- Synchronized playback log correlating telemetry frames with asset mutations
- System-clock sync between telemetry and render frames

## Later (editor roadmap)

- WebXR session on Quest browser: passthrough + controller-tracked virtual camcorder.
  Director Mode already speaks MOVE_CAMERA from telemetry, so a headset replaces
  `mock_telemetry.py` with real pose data — same wire path.
- Persistence for agent-built scenes (extend EXPORT_JSON with lighting + materialOverride).
