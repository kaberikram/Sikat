# Glossary

- **Director Mode** — the agent-driven control layer: text/voice direction in, live scene changes out.
- **Spatial client** — the RADIO_EDIT.EXE editor (Three.js/React), the PRD's Unity alternative. Will become the WebXR client in the XR phase.
- **Viewfinder / PiP** — the virtual camera's picture-in-picture render. FX apply **only** here, never to the user's main view (comfort invariant, critical for XR passthrough).
- **Virtual camera** — the camcorder the timeline records; store id `virtualCamera`.
- **Command packet** — one validated JSON instruction from the swarm to the client (`SPAWN_OBJECT`, `UPDATE_LIGHTS`, …). See [[Command_Protocol]].
- **Intent** — the Director's Assistant's intermediate parse of one instruction, before specialists convert it into packets.
- **Specialist agent** — deterministic Python that turns intents into packets (Lighting Tech, Asset Animator, VFX Operator).
- **Mood macro** — a `set_scene` intent the Producer expands into a lights + FX packet batch (noir, sunset, studio, neon).
- **Transition** — optional `{durationSec, easing}` on a packet; the client tweens (or bakes keyframes) instead of snapping.
- **Scene snapshot** — debounced `scene_state` message the client sends up so agents know real object names/transforms.
- **Fallback parser** — the deterministic rule grammar used when no `ANTHROPIC_API_KEY` is set or the LLM parse fails.
