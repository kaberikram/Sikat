# PRD: Multi-Agent Directing Studio (adapted for RADIO_EDIT.EXE)

## Vision

A "Zero-UI" virtual production stage: the director speaks (or types) and an AI
crew executes — spawning props, relighting the set, dialing FX, moving the
camera — while the human frames shots. The original PRD targeted Unity/OpenXR;
this adaptation keeps RADIO_EDIT.EXE's **Three.js/React** editor as the spatial
client (the PRD's accepted WebXR alternative), so nothing was rewritten and the
editor's existing timeline/virtual-camera model becomes the recording layer.

## What changed from the original PRD

| Original PRD | This implementation | Why |
|---|---|---|
| Unity (MRTK3/OpenXR) client | Existing Three.js/React editor | PRD lists WebXR as accepted alternative; editor already has stage, virtual camera, FX stack, timeline |
| LangGraph / CrewAI | Hand-rolled async pipeline | The flow is a straight DAG (parse → route → validate → emit); a graph framework adds a heavy dependency for zero branching benefit |
| GPT-4o / Claude 3.5 Sonnet | Claude (claude-sonnet-5) via structured outputs, plus a deterministic fallback grammar | Structured outputs guarantee parseable JSON; the fallback makes the whole system runnable without any API key |
| Whisper transcription | Browser `webkitSpeechRecognition` (progressive enhancement) | No key, no upload; typed input is the baseline |
| `duration_ms` in packets | `transition: {durationSec, easing}` | Matches the editor's seconds-based timeline |

## Architecture (as built)

```
┌────────────────────────────────────────────────────────────┐
│  SPATIAL CLIENT — RADIO_EDIT.EXE (Three.js / React / Vite) │
│  DirectorConsole · command-applier · tween · Zustand store │
└──────────────┬─────────────────────────────▲───────────────┘
   scene_state │  user_command  · telemetry  │ agent_command
               ▼                             │ agent_log · error
┌────────────────────────────────────────────┴───────────────┐
│  BACKEND — FastAPI WebSocket  (server/app/main.py)         │
└──────────────┬─────────────────────────────▲───────────────┘
               ▼                             │
┌────────────────────────────────────────────┴───────────────┐
│  AI CREW SWARM (server/app/agents/)                        │
│  [Producer]           routes intents, mood macros, playback │
│  [Director's Asst]    text → structured Intents (LLM/rules) │
│  [Asset Animator]     spawn/remove/transform/animate/camera │
│  [Lighting Tech]      lights + materials                    │
│  [VFX Operator]       viewfinder post-processing stack      │
└────────────────────────────────────────────────────────────┘
```

## Non-negotiable invariants (inherited from the editor)

1. **FX only on the viewfinder.** Agents may change the post stack, but it renders
   only in the virtual camera PiP — the user's main view stays clean. In XR this
   becomes: never post-process the passthrough view.
2. **All scene mutation goes through the Zustand store.** `Scene.tsx` stays the
   only renderer-aware module; the applier writes state, the render loop applies it.
3. **Keyframes override base transforms** — see [[System_Architecture]] for the
   tween-vs-keyframe policy this forces.

## Success criteria (verified)

- Type "add a red box then dim the lights then enable bloom" → three packets from
  three specialists, all applied live, `< 100 ms` end-to-end on the fallback path.
- Whole pipeline runs with **no API key** and no headset.
- 20 Hz mock camera telemetry drives the virtual camera through the same wire path
  a headset will use.
