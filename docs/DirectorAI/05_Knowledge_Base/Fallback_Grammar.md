# Fallback Grammar (server/app/fallback_parser.py)

The deterministic parser: active when no `ANTHROPIC_API_KEY` is set and as the
safety net on any LLM failure. Fully covered by `tests/test_fallback_parser.py`.
Keep this table in sync with the code.

## Clause handling

Input splits on `;`, `. `, `then` / `and then`. Each clause yields at most one
intent; unrecognized clauses are dropped (an all-drop command returns a
structured `error` to the console).

`over/for/in N seconds` anywhere in a clause → `transition.durationSec` (removed
before verb matching).

## Rule order (first match wins)

| # | trigger | intent |
|---|---|---|
| 1 | `play`/`action` · `pause`/`stop`/`cut` · `go to N` · `rewind` | playback |
| 2 | mood word (noir/moody, sunset/golden hour, studio/neutral, neon/cyberpunk) + mood context (`mood/scene/vibe/feel/make it/...`) or bare | set_scene |
| 3 | FX word (bloom/glow, pixelate, glitch, dither, cell shading/outline) + on/off/more/less/`<param> to N` | update_fx |
| 4 | light words (dim, brighten, lights off, warm/cool, background `<color>`, intensity to N) | update_lights |
| 5 | camera words (zoom in/out, push in, pull back, fov N, look at X, camera to x y z) | move_camera |
| 6 | turnaround / 360 / spin around / orbit / bounce + target | animate |
| 7 | remove/delete/destroy + target | remove |
| 8 | paint/color/tint/make/turn + **existing** object + color (`glow` adds emissive) | set_material |
| 9 | add/spawn/create/make/drop/place + primitive word (`called X` names it, `at x y z` places it, quoted text for tags) | spawn |
| 10 | scale/grow/shrink/double/halve (`by N` relative multiply, `to N` absolute) | transform (scale) |
| 11 | rotate/spin/turn + `N degrees` (axis words x/pitch, z/roll; default yaw) → radians | transform (rotation) |
| 12 | move/raise/lower/nudge + direction (up/down/left/right/forward/back) + amount, or `to x y z` | transform (position) |

## Lookup tables

- **Colors:** red `#ff3b30`, blue `#0a84ff`, green `#30d158`, yellow `#ffd60a`,
  orange `#ff9f0a`, purple `#bf5af2`, pink `#ff2d55`, white, black `#111111`,
  cyan, magenta, gray/grey `#8e8e93`, gold `#ffd700`, teal `#64d2ff`, brown `#a2845e`,
  plus literal `#rrggbb`.
- **Primitives:** box/cube/crate, sphere/ball/orb, cone, cylinder/tube,
  torus/donut/ring, plane/floor/ground, text/tag/sign/label.
- **Directions:** up +Y, down −Y, left −X, right +X, forward −Z, back +Z.

## Target resolution (parser side)

Scene snapshot names win: exact substring, then token match ("sphere" →
`CORE_SPHERE`), then primitive aliasing ("ball" → sphere → `SPHERE_MDL_02`).
Without a snapshot match the bare noun is passed through — the client applier
does its own id → exact → substring resolution at apply time, so stale
snapshots don't break addressing.
