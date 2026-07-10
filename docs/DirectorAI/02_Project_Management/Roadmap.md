# Roadmap

## Shipped — "Thinking crew" pass (live agent direction UX)

Turned live direction from "system executing commands" into a crew that feels
present. Architecture invariant held throughout: `user_command → parse →
Intent[] → Producer → CommandPacket[] → client applier` — no wire-protocol
packet changes; chatter and telemetry ride the existing `agent_status.note` /
`agent_log` fields.

- [x] **Phase 1** — Removed TTS entirely (`set-radio.ts` deleted; it bled into
      the director's own mic recording and the always-on live-listen input).
      Visual-only affirmation now: `markAgentActive('Producer', …)` on submit,
      rotating through a small note pool (copy / on it / hearing you / rolling
      on that) instead of a fixed word.
- [x] **Phase 2** — Latency telemetry: `src/director/latency.ts` tracks
      utterance→first-packet and utterance→first-apply per `commandId`,
      logged to the DirectorPod console (`⏱ first packet 1.42s`). Server
      (`llm.py`, `main.py`) logs parse duration + time-to-first-packet.
- [x] **Phase 3** — Streaming intents: `llm.stream_intents` (async
      Anthropic/OpenAI clients) + `extract_complete_intents`, a pure
      incremental JSON-array-element extractor (brace/bracket depth +
      in-string/escape tracking). The Producer now streams packets per
      completed intent instead of waiting for the full LLM response; falls
      back to `parse_intents` / the rule parser on any stream error or zero
      yielded intents.
- [x] **Phase 4** — LLM chatter: `Intent.say` (server-internal, not on the
      wire) carries an in-character film-set radio line generated alongside
      each intent — zero extra API calls. Producer uses it as the
      `agent_status` note and the specialist's log line; static `_COMMAND_NOTE`
      verbs remain the fallback when no LLM is configured.
- [x] **Phase 5** — Per-performer memory + persona: `PerformerAssignment.recent`
      (bounded deque) plus a fixed persona table (Agent 1 precise/minimal,
      Agent 2 playful/big, Agent 3 moody/dramatic, Agent 4 fast/energetic),
      surfaced in the LLM system prompt via `performers.brief()` so "again but
      bigger" grounds against that performer's own last move.
- [x] **Phase 6** — Barge-in v1: `agent-runtime.ts`'s `enqueuePacket` drops a
      stale queued packet when a newer command targets the same object with
      the same command type, so corrections don't wait behind superseded
      queued work. In-flight tween retargeting already worked; this closed
      the remaining queue-ordering gap.

## Shipped — Scene-Aware Director (Phases A–E)

Phased brief: `06_Implementation_Brief/Scene_Aware_Director.md`. All phases complete:

- [x] **Phase A** — Rich scene context (heartbeat + full snapshot, sampled poses, `describe` intent)
- [x] **Phase C** — Set radio (browser TTS ACKs on agent active)
- [x] **Phase B** — Vision on command (viewfinder JPEG; Anthropic multimodal)
- [x] **Phase D** — Hold / Action / Cut (playback transport semantics)
- [x] **Phase E** — Streaming partial intents (per-clause emit; LLM in parallel)

Hybrid LLM routing: DeepSeek for text-only, Anthropic when viewfinder JPEG attached.

## Agent-Loop Director

- [x] Whole-utterance `DirectorPlan` streaming with fast Haiku planning and
      Sonnet escalation for bespoke choreography.
- [x] Plan progress wire/UI, pitch mode, plan journal, and deterministic
      best-effort undo from the command-entry scene snapshot.
- [ ] Remove the remaining legacy clause-routing compatibility helpers once
      downstream tests and deployments no longer exercise them.

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

- [x] WebXR session on Quest browser: passthrough + controller-tracked virtual camcorder (`src/scene/xr/` — immersive-ar, camcorder rig on right grip, RT viewfinder on rig screen, trigger record/cut). v1 uses local `applyLiveCameraPose` only (no headset telemetry to server).
- [ ] WebXR telemetry sender-exclusion (server-side) before enabling headset → `MOVE_CAMERA` wire path (avoids feedback loop with local pose).
- [ ] FX-on-RT composer for XR viewfinder (v1 renders direct-to-RT without post stack).
- [ ] Hand-tracking grab for camcorder rig.
- [ ] On-device Quest 3 MP4 export verification (WebCodecs).
- Persistence for agent-built scenes (extend EXPORT_JSON with lighting + materialOverride).
