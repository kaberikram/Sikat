# Command Protocol (normative)

Implementations: `server/app/schema.py` (pydantic, authoritative validation) and
`src/director/protocol.ts` (TS mirror). Change all three together.

- Endpoint: `ws://<host>:8000/ws` (frontend override: `VITE_DIRECTOR_WS_URL`)
- Envelope: every message is JSON with `type` and `timestamp` (unix seconds, float)
- Rotations: world-space euler XYZ **radians** · Colors: `"#rrggbb"`
- Out-of-range numeric values are **clamped, never rejected** (ranges mirror the editor's sliders)

## Client → server

| type | fields | notes |
|---|---|---|
| `user_command` | `text`, `commandId` | one director instruction (may contain several clauses) |
| `scene_state` | `objects[] {id,name,position,rotation,scale,keyframedProperties}`, `camera {position,rotation,fov}`, `duration`, `isPlaying` | sent on connect + debounced 300 ms on change |
| `telemetry` | `source`, `pose {position, rotation?, fov?}` | camera-operator pose; server converts to `MOVE_CAMERA` (throttled ≤ 20 Hz) |

## Server → client (multicast)

| type | fields |
|---|---|
| `agent_command` | `packet` (CommandPacket below) |
| `agent_log` | `agent`, `level (info\|warn\|error)`, `message`, `forCommandId?` |
| `error` | `message`, `forCommandId?` |

## CommandPacket

```json
{
  "timestamp": 1751437200.5,
  "target_agent": "LightingTech",
  "command": "UPDATE_LIGHTS",
  "commandId": "uuid-of-originating-user_command",
  "transition": { "durationSec": 1.2, "easing": "easeOut" },
  "payload": { "ambient": { "color": "#00ffff", "intensity": 1.2 } }
}
```

`transition` is optional; when present the client animates instead of snapping.
Easings: `linear | easeIn | easeOut | easeInOut` (cubic).

`Target` = `{id?, name?}` (at least one). Resolution happens client-side at apply
time: id match → case-insensitive exact name → substring.

## Command vocabulary

| command | agent | payload |
|---|---|---|
| `SPAWN_OBJECT` | AssetAnimator | `primitive (box\|sphere\|cone\|cylinder\|torus\|plane\|text)`, `id?`, `name?`, `color?`, `text?`, `position?`, `rotation?`, `scale?` |
| `REMOVE_OBJECT` | AssetAnimator | `target` |
| `TRANSFORM_OBJECT` | AssetAnimator | `target`, `mode (absolute\|relative)`, `position?`, `rotation?`, `scale?` — relative scale multiplies, relative position/rotation adds |
| `ANIMATE_OBJECT` | AssetAnimator | `target`, `preset (turnaround\|orbit\|bounce)`, `durationSec?` |
| `MOVE_CAMERA` | AssetAnimator | `position?`, `rotation?`, `lookAt? (Vec3)`, `lookAtTarget? (Target)`, `fov? (5–120)` |
| `UPDATE_LIGHTS` | LightingTech | `ambient? {color?, intensity? 0–4}`, `key? {color?, intensity? 0–8, position?}`, `background?` |
| `SET_MATERIAL` | LightingTech | `target`, `color?`, `emissive?`, `emissiveIntensity? 0–5`, `opacity? 0–1` |
| `UPDATE_FX` | VFXOperator | `section (bloom\|pixelate\|cellShading\|glitch\|dither)`, `patch` — keys/ranges per section below |
| `SET_KEYFRAMES` | AssetAnimator | `target?` (omit ⇒ virtual camera), `property (position\|rotation\|scale\|fov)`, `keyframes[] {time, value}` |
| `PLAYBACK` | Producer | `action (play\|pause\|seek)`, `time?` |

`SET_SCENE` is intentionally **not** a wire command: the Producer expands mood
intents (noir, sunset, studio, neon) server-side into `UPDATE_LIGHTS` + `UPDATE_FX`
batches, so the client vocabulary stays minimal.

### UPDATE_FX patch keys (clamped ranges = editor sliders)

| section | keys |
|---|---|
| bloom | `enabled`, `strength 0–2.5`, `threshold 0–1`, `radius 0–1`, `emissiveBoost 0–1.5`, `emissiveIntensity 0–3` |
| pixelate | `enabled`, `pixelSize 2–24`, `normalEdge 0–0.8`, `depthEdge 0–0.8` |
| cellShading | `enabled`, `outlineScale 1–1.18` |
| glitch | `enabled`, `intensity 0–0.5`, `rate 0–0.35` |
| dither | `enabled`, `pixelSize 1–10`, `levels 2–16`, `strength 0–1`, `monochrome` |
