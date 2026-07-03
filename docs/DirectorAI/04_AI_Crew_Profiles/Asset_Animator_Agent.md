# Asset Animator

**Code:** `server/app/agents/asset_animator.py` (server) + `src/director/spawn-factory.ts`,
`src/animation-presets.ts`, `src/director/tween.ts` (client half) · **Kind:** deterministic specialist

## Role

Everything that moves or exists: spawning/removing props, transforms (with eased
transitions), animation presets, and virtual-camera moves.

## Owned commands

- `SPAWN_OBJECT` — client builds MeshToon primitives (or canvas-texture text tags)
  mirroring the editor toolbar's material choices; agent names default to `BOX_AGT_01` style.
- `REMOVE_OBJECT`, `TRANSFORM_OBJECT` (absolute/relative; relative scale multiplies)
- `ANIMATE_OBJECT` — presets share `src/animation-presets.ts` with the editor UI:
  `turnaround` (the 360 button's exact math), `orbit` (circle at current radius),
  `bounce` (decaying hops sampled for linear interpolation). Applier rewinds to 0 and starts playback.
- `MOVE_CAMERA` — position/rotation/fov tweens; `lookAtTarget` resolved client-side
  via `Matrix4.lookAt` → euler. Default transition 1.5 s when the parser sees a camera verb.

## Unit discipline

Rotations reach this agent already in radians (parser converts "90 degrees").
Positions are world units; relative directions map screen-speak to axes
(`up +Y`, `forward −Z` per Three.js camera convention).

## Failure modes

- Missing target on remove/transform/animate → intent dropped (Producer logs a warn).
- Target that doesn't resolve client-side → console shows `target not found: <name>`.
- Transform on a keyframed property with a transition → baked into keyframes, not tweened
  (see [[System_Architecture]] policy table).
