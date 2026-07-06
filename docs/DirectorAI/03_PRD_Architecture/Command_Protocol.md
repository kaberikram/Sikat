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
| `user_command` | `text`, `commandId`, `scene?`, `frame?` | one director instruction; `scene` is a full snapshot (`mode: full`) at command time; `frame` is an optional viewfinder JPEG (base64, no `data:` prefix) when vision triggers fire — never on heartbeat |
| `scene_state` | see **SceneState** below | sent on connect + debounced 300 ms on change (`mode: heartbeat`) |
| `telemetry` | `source`, `pose {position, rotation?, fov?}` | camera-operator pose; server converts to `MOVE_CAMERA` (throttled ≤ 20 Hz) |

### SceneState (heartbeat + full)

Breaking change: `camera` → **`virtualCamera`**.

| field | heartbeat | full (on `user_command.scene`) |
|---|---|---|
| `mode` | `"heartbeat"` | `"full"` |
| `currentTime`, `duration`, `isPlaying`, `isRolling?`, `takeStartTime?`, `selectedId?`, `stage? {position, radius}` | ✓ | ✓ |
| `objects[]` | summary tracks (`keyframeCount`) | full keyframes per track |
| `virtualCamera` | sampled pose, fx summary, track counts | + full keyframe data |
| `lighting` | `{ambient, key, background}` | ✓ |

**ObjectSnapshot:** `id`, `name`, `position/rotation/scale` (base store values), `sampled {position, rotation, scale}` (interpolated at `currentTime`), `keyframedProperties[]`, `tracks[]`, `materialOverride?`

**Track shapes:** heartbeat → `{property, keyframeCount}` · full → `{property, keyframes[] {time, value}}`

**VirtualCameraSnapshot:** base + `sampled`, `sampledFov`, `tracks[]`, `fx {enabledSections[], bloomStrength?, ditherLevels?}`

**SceneFrame** (vision on command): `{mime: "image/jpeg", width, height, data (base64, no prefix), capturedAt}` — attached only on `user_command` when the client detects vision triggers (`shouldAttachVision`) or Shift+mic; server Anthropic path sends multimodal; DeepSeek skips the image.

## Server → client (multicast)

| type | fields |
|---|---|
| `agent_command` | `packet` (CommandPacket below) |
| `intent_preview` | `commandId`, `agent`, `note`, `confidence (guess\|grammar\|llm_partial)`, `target?`, `action?`, `motion?` |
| `agent_status` | `agent`, `status (active\|idle)`, `forCommandId?`, `note?` |
| `command_cancel` | `commandId`, `supersededBy?`, `target?`, `command?`, `reason? (supersede\|stop\|amend)` |
| `agent_question` | `agent`, `commandId`, `question`, `options[]` |
| `agent_suggestion` | `suggestionId`, `agent`, `text`, `kind (observation\|suggestion\|reaction)`, `suggestedCommand?`, `subjectObject?` |
| `agent_log` | `agent`, `level (info\|warn\|error)`, `message`, `forCommandId?` |
| `error` | `message`, `forCommandId?` |

### Progressive execution (Phase F)

On `user_command` receipt the server emits **`intent_preview`** synchronously
(before LLM parse completes) so the client can move cursors immediately. While
the LLM streams, partial field previews may arrive with `confidence: llm_partial`.

When grammar matches but LLM refinement is still pending, the server **coarse-emits**
packets first, then sends **`refinement: true`** packets when the full intent lands.
Refinement packets merge into motion from `currentTime` — the client skips the
full cursor fly/hover/settle cycle for them.

### Staged execution & agent cursors

A `user_command` is planned deterministically (parse → build), then the crew's
packets are **streamed over time** rather than in one burst. The Producer groups
packets by `target_agent` and runs each specialist as a concurrent worker that
emits `agent_status` `active`, its `agent_command` packets (≈0.25 s apart), then
`agent_status` `idle`. Specialists are staggered (~0.15 s) so their statuses
interleave.

`agent_status` is **semantic presence only** — it carries no coordinates. The
client owns choreography: it queues each agent's packets and, per packet, flies
that agent's on-stage cursor to a 3D target it derives from the packet itself
(spawn position, resolved object transform, key-light position, …), hovers,
commits the change, then settles. `active` shows the cursor; `idle` fades it
once the client-side queue drains.

`agent_status.note` carries in-character film-set radio chatter (e.g. "taking
the sphere up on a three-count") when the LLM path is active — this rides
directly from the Director's Assistant's server-internal `Intent.say` field
(never mirrored to `protocol.ts`; `Intent` is not part of the wire schema, only
its effects are). The client shows this line on the agent's cursor chip and
prefers it over the generic per-command fallback derived from the packet
shape. Grammar-only fallback parses (no API key) have no `say`, so `note`
falls back to a static per-command verb ("spawning", "animating", …).

## CommandPacket

```json
{
  "timestamp": 1751437200.5,
  "target_agent": "LightingTech",
  "command": "UPDATE_LIGHTS",
  "commandId": "uuid-of-originating-user_command",
  "refinement": false,
  "priorCommandId": null,
  "transition": { "durationSec": 1.2, "easing": "easeOut" },
  "payload": { "ambient": { "color": "#00ffff", "intensity": 1.2 } }
}
```

`transition` is optional; when present the client animates instead of snapping.
When omitted on `TRANSFORM_OBJECT`, `UPDATE_LIGHTS`, or `SET_MATERIAL`, the server
injects a default ~0.6–0.9s `easeOut` glide (scaled by move distance). Say
**snap** / **instantly** to disable tweening.
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
| `PLAYBACK` | Producer | `action (play\|pause\|seek\|record\|cut)`, `time?` |

**Take transport:** `record` starts a keyframe take (sets rolling, auto-samples camera + bakes agent moves). `cut` ends the take. `play`/`pause` are preview transport only.

**Numbered performers:** `Agent1`–`Agent4` are valid `target_agent` values for addressed packets. Assignments are server-side (`assign` intent) and persist across takes.

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

### Proactive crew (Living Crew Phase A)

The server runs a per-session **observer** on scene heartbeats. When deterministic
detectors notice issues (off-stage objects, bloom washout, static takes, manual
edits, …) it may emit `agent_suggestion` **to that socket only** (not multicast).

- **`kind: observation`** — scene issue with optional `suggestedCommand`; client
  shows a chip above the director input with `[DO IT]` / `[DISMISS]`.
- **`kind: suggestion`** — follow-up pitch after a command completes (LLM
  `suggest` intent); same chip UX.
- **`kind: reaction`** — cursor glance + note only; no chip (manual-edit tier).

`DO IT` re-enters the normal `user_command` pipeline with a **fresh**
`commandId` — suggestions never auto-apply packets. Dismiss is client-local;
stale suggestions may be dropped (25 s auto-expire on client).

Kill switch: `DIRECTOR_PROACTIVE=0` disables all proactive behavior server-side.
