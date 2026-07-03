# System Architecture

## Data flow, end to end

1. **Input** — DirectorConsole (`src/director/DirectorConsole.tsx`) takes typed text,
   or speech via `webkitSpeechRecognition` where available, and sends a
   `user_command` with a client-generated `commandId`.
2. **Grounding** — `scene-state-sync.ts` streams debounced (300 ms) scene snapshots
   (object ids/names/transforms, camera, playback state) so agents can resolve
   "the sphere" to `CORE_SPHERE`.
3. **Parse** — Director's Assistant (`agents/directors_assistant.py`): Anthropic
   structured outputs when `ANTHROPIC_API_KEY` is set; otherwise (or on any
   failure) the deterministic grammar in `fallback_parser.py`. Output: `Intent[]`.
4. **Route + build** — Producer maps each intent to a specialist; specialists are
   pure Python that emit pydantic-validated `CommandPacket`s (units converted,
   values clamped). `set_scene` moods expand server-side into lights+FX batches.
5. **Multicast** — `main.py` broadcasts `agent_log` breadcrumbs and `agent_command`
   packets to every connected client. LLM latency never blocks the socket loop
   (commands are handled in `asyncio.create_task`).
6. **Apply** — `command-applier.ts` resolves targets (id → exact name → substring)
   and writes the Zustand store. `Scene.tsx`'s RAF loop re-applies store state every
   frame, so a store write **is** a scene change.

## The tween-vs-keyframe policy (the one sharp edge)

`interpolateKeyframes` returns keyframed values whenever a property has *any*
keyframes — base values are ignored. So a naive tween on a keyframed property
would be invisible. The applier's policy (`applyObjectVector`):

| Target property state | Transition present | What happens |
|---|---|---|
| no keyframes | no | write base value |
| no keyframes | yes | tween the base value (shared rAF engine, `tween.ts`) |
| has keyframes | no | write base + commit a keyframe at `currentTime` (mirrors the Properties panel) |
| has keyframes | yes | **bake** the eased move into ~8 linear keyframe segments from `currentTime` |

Other tween rules: a new tween on the same `objectId:property` cancels the old
one; the engine holds (shifts start times) while `isExporting`; tweens write
store values only — never Three objects — so gizmo-drag guards keep working
(gizmo vs incoming tween is last-writer-wins, accepted for v1).

## Lighting bridge

Lights were hard-coded in `Scene.tsx`; they are now a store slice
(`lighting: SceneLighting`, defaults identical to the old constants) that the
render loop applies every frame — the same pattern the FX stack already used.
`UPDATE_LIGHTS` is therefore just `updateLighting(patch)`.

## Failure behavior

- Invalid client message → structured `error` reply, connection stays up.
- Unactionable text → `error` with the original `commandId` (console shows it).
- LLM exception/invalid JSON → silent downgrade to the rule grammar (logged server-side).
- Dead sockets are dropped from the broadcast set on first send failure.
- Client reconnects with 1s→10s backoff (±20% jitter) and re-sends the scene snapshot.
