# Scene-Aware Director Mode

**Status:** Ready to implement  
**Prerequisite:** Director Mode shipped (FastAPI + DirectorPod + multi-agent crew)  
**Goal:** Agents understand animation/timeline/FX from structured data; attach viewfinder snapshots only when needed; add verbal ACKs and hold/action/cut semantics.  
**Non-goal:** Do NOT adopt Gemini Live API. Do NOT replace structured `Intent[]` → `CommandPacket` pipeline.

---

## Product intent

The director should be able to say things like:

- *"How's the bounce on the sphere?"* → descriptive answer from keyframe data
- *"Look at the shot — too dark?"* → vision + lighting data → suggest/fix
- *"Hold." / "Action." / "Cut."* → playback gating like a real set
- *"Add a red box then dim the lights"* → first packet streams before full parse finishes

**Core principle:** Data is always on. Vision is on-command. Commands still exit through validated packets.

---

## Architecture invariant (do not break)

```
user_command → DirectorsAssistant.parse → Intent[] → Producer → CommandPacket[] → client applier
scene_state  → scene_state.latest() grounds parsing (debounced heartbeat)
```

- Rotations: world-space euler XYZ **radians**
- Colors: `#rrggbb` lowercase hex
- FX only on viewfinder (virtual camera post stack)
- All mutation via Zustand store writes
- Normative protocol — keep **three** files in sync:
  - [[Command_Protocol]]
  - `server/app/schema.py`
  - `src/director/protocol.ts`

---

# PHASE A — Rich Scene Context (implement first)

## A1. Wire contract: expand `scene_state`

### Heartbeat snapshot (debounced 300ms, always streaming)

```python
class MaterialOverrideSnapshot(BaseModel):
    color: HexColor | None = None
    emissive: HexColor | None = None
    emissiveIntensity: float | None = None
    opacity: float | None = None

class KeyframeTrackSummary(BaseModel):
    property: Literal["position", "rotation", "scale", "fov"]
    keyframeCount: int

class SampledTransform(BaseModel):
    position: Vec3
    rotation: Vec3
    scale: Vec3

class ObjectSnapshot(BaseModel):
    id: str
    name: str
    position: Vec3          # base (store) transform
    rotation: Vec3
    scale: Vec3
    sampled: SampledTransform # interpolated at currentTime
    keyframedProperties: list[str]  # keep existing field name
    tracks: list[KeyframeTrackSummary]
    materialOverride: MaterialOverrideSnapshot | None = None

class FxSummary(BaseModel):
    enabledSections: list[FxSection]
    bloomStrength: float | None = None
    ditherLevels: int | None = None

class VirtualCameraSnapshot(BaseModel):
    position: Vec3
    rotation: Vec3
    fov: float
    sampled: SampledTransform
    sampledFov: float
    keyframedProperties: list[str]
    tracks: list[KeyframeTrackSummary]
    fx: FxSummary

class SceneLightingSnapshot(BaseModel):
    ambient: AmbientLightPatch  # reuse existing patch models
    key: KeyLightPatch
    background: HexColor

class SceneState(BaseModel):
    type: Literal["scene_state"] = "scene_state"
    timestamp: float
    mode: Literal["heartbeat", "full"] = "heartbeat"
    currentTime: float
    duration: float
    isPlaying: bool
    selectedId: str | None = None
    objects: list[ObjectSnapshot]
    virtualCamera: VirtualCameraSnapshot
    lighting: SceneLightingSnapshot
```

**Breaking change:** rename `camera` → `virtualCamera` on both client and server. Migrate together.

### Full snapshot (sent with every `user_command`)

Same shape with `mode: "full"`. Replace track summaries with full keyframes:

```python
class KeyframePoint(BaseModel):
    time: float
    value: Vec3

class KeyframeTrackFull(BaseModel):
    property: Literal["position", "rotation", "scale", "fov"]
    keyframes: list[KeyframePoint]  # sorted by time
```

In full mode, `tracks` becomes `list[KeyframeTrackFull]` (use a union or separate field `tracksFull` if pydantic discriminated unions get awkward — prefer one `tracks` field with a mode flag on parent).

### Extend `user_command`

```python
class SceneFrame(BaseModel):
    mime: Literal["image/jpeg"] = "image/jpeg"
    width: int
    height: int
    data: str  # base64, no data: prefix
    capturedAt: float

class UserCommand(BaseModel):
    type: Literal["user_command"] = "user_command"
    timestamp: float
    text: str = Field(min_length=1)
    commandId: str | None = None
    scene: SceneState | None = None   # full snapshot at command time
    frame: SceneFrame | None = None   # Phase B — optional JPEG
```

---

## A2. Client: `src/director/scene-state-sync.ts`

### New exports

```ts
export function buildHeartbeatSnapshot(): Omit<SceneSnapshot, 'type' | 'timestamp'>
export function buildFullSnapshot(): Omit<SceneSnapshot, 'type' | 'timestamp'>
export function sampleObjectAtTime(obj, currentTime): SampledTransform
export function sampleVirtualCameraAtTime(vc, currentTime): { sampled, sampledFov }
```

### Sampling rules

Reuse `interpolateKeyframes` from `src/keyframe-interpolation.ts`:

- Per object: sample position, rotation, scale at `currentTime`
- Virtual camera: sample position, rotation, fov at `currentTime`
- `sampled` = what's on screen during playback
- `position/rotation/scale` = base store values (edit semantics)

### Sync behavior

1. **Heartbeat:** existing 300ms debounce → `buildHeartbeatSnapshot()` → `socket.sendSceneState()`
2. **On command:** `buildFullSnapshot()` embedded in `user_command` (see A3)

### Store fields

From `useEditorStore.getState()`:

- `objects[]` with keyframes, `materialOverride`
- `virtualCamera` with `postProcessing`, keyframes
- `lighting`
- `currentTime`, `duration`, `isPlaying`, `selectedId`

### FxSummary builder

Only enabled section names + 1–2 salient values per section. Target: **&lt;4KB** heartbeat for ~10 objects.

---

## A3. Client: `src/director/socket.ts`

Update `sendUserCommand(text)`:

1. `buildFullSnapshot()`
2. Phase B: optionally `captureViewfinderFrame()` when `shouldAttachVision(text)` 
3. Send single message with embedded `scene` (+ `frame`)

Server `_handle_user_command`: use `msg.scene or scene_state.latest()`.

---

## A4. Server: `server/app/scene_context.py` (NEW)

```python
def format_scene_brief(scene: SceneState | None) -> str:
    """Compact text briefing for LLM system prompt injection."""
```

### Brief format (token-optimized)

```
TIMELINE: t=2.40s / 10.0s | playing | selected=CORE_SPHERE

OBJECTS (3):
- id "abc123" name "Sphere"
  base pos (0,0,0) rot (0,0,0) scale (1,1,1)
  NOW  pos (0,1.2,0) rot (0,0.9,0) scale (1,1,1)
  tracks: position×6 (0.0–4.0s, Y 0→2.5→0), rotation×4
  material: color=#ff3b30

VIRTUAL CAMERA:
  base pos (0,1.25,6) fov 50
  NOW  pos (0,1.25,5.2) fov 48
  tracks: position×0
  fx: bloom(0.9), cellShading

LIGHTING: ambient #ffffff×0.8 | key #ffffff×1.5 @(5,10,7) | bg #f2f2f2
```

### Full mode extras

Compressed keyframe listing per track:

```
  position kf: 0@0,0,0 | 1@0,2.5,0 | 2@0,0,0 | ...
```

Cap: &gt;20 keyframes → first 3 + `…` + last 2 + total count.

### Animation heuristics (server-side, no LLM math)

```python
def summarize_track(property, keyframes) -> str:
    # "position×6 (0–4s, Y range 0→2.5, bounce-like)"
```

- `duration` = last.time - first.time
- Position Y min/max → `Y range a→b`
- Y oscillates ≥2 peaks → `bounce-like`
- Rotation monotonic → `spin/turnaround-like`

---

## A5. New intent: `describe` (log-only)

Add to `IntentAction`:

```python
"describe"
```

```python
class Intent(BaseModel):
    # ...existing fields...
    describe_topic: Literal["scene", "animation", "lighting", "fx", "camera", "object"] | None = None
    describe_message: str | None = None
```

### Producer behavior

- ALL intents are `describe` → emit `agent_log` with `describe_message`, **zero** packets, no `error`
- Mixed ("too dark, fix it") → describe + mutating intents; only mutating become packets

### Fallback parser patterns

- `what's happening`, `describe the shot`, `how's the animation` → `describe(scene|animation)`
- `how's the bounce on <target>` → `describe(animation)` with target context

---

## A6. LLM prompt

Full prompt text: [[LLM_System_Prompt]]

Wire into `server/app/llm.py`:

```python
def _system_prompt(scene: SceneState | None) -> str:
    scene_brief = format_scene_brief(scene)
    return SYSTEM_PROMPT_TEMPLATE.format(
        scene_brief=scene_brief,
        history_section=_history_section(),
    )
```

---

## A7. Files to touch (Phase A)

| File | Change |
|------|--------|
| `server/app/schema.py` | Expand SceneState, UserCommand, Intent |
| `src/director/protocol.ts` | Mirror schema |
| `docs/.../Command_Protocol.md` | Document new fields |
| `src/director/scene-state-sync.ts` | Heartbeat + full builders, sampling |
| `src/director/socket.ts` | sendUserCommand embeds full scene |
| `server/app/scene_context.py` | **NEW** |
| `server/app/llm.py` | New system prompt |
| `server/app/main.py` | Pass `msg.scene` to producer |
| `server/app/agents/producer.py` | Handle describe-only commands |
| `server/app/fallback_parser.py` | describe patterns |
| `server/tests/test_scene_context.py` | **NEW** |
| `server/tests/test_describe_intent.py` | **NEW** |
| `docs/.../Directors_Assistant_Agent.md` | Update prompt summary |

---

## A8. Acceptance criteria (Phase A)

- [ ] Heartbeat sync includes `currentTime`, sampled poses, lighting, fx summary
- [ ] Every `user_command` carries full keyframe data
- [ ] LLM prompt uses scene brief, not raw JSON
- [ ] "how's the bounce on the sphere" → describe intent, log message, zero packets
- [ ] "move the sphere up 2" still emits `TRANSFORM_OBJECT` packet
- [ ] Fallback parser works with no API key
- [ ] `uv run pytest` passes; `npm run lint` clean
- [ ] Heartbeat payload &lt;4KB for scene with 10 objects

---

# PHASE B — Vision on Command

## B1. Client: `src/director/viewfinder-capture.ts` (NEW)

```ts
export async function captureViewfinderFrame(opts?: {
  maxWidth?: number  // default 640
  quality?: number   // default 0.75
}): Promise<SceneFrame | null>
```

1. `getSceneForExport()` from `scene-export-registry.ts`
2. Render viewfinder once via `renderViewfinderExportFrame` / `renderViewfinderFrame`
3. Downscale + JPEG via canvas
4. Return `null` if export context not registered

**Never** capture on heartbeat — only on `user_command`.

## B2. Client: `src/director/vision-triggers.ts` (NEW)

```ts
export function shouldAttachVision(text: string): boolean
```

True if ANY:

- Keywords: `look`, `see`, `check`, `frame`, `shot`, `how does (this|it) look`, `too (dark|bright|moody|flat)`, `composition`, `viewfinder`
- Prefix: `?look` or `?vision`
- Optional UX: Shift+mic or long-press mic in DirectorPod

## B3. Server

`parse_intents(text, scene, frame=None)` — Anthropic multimodal path.

Never persist JPEGs. Debug-log attachment size only.

## B4. Acceptance criteria (Phase B)

- [ ] "look at the shot" attaches JPEG ≤100KB typical
- [ ] "move box up 2" does NOT attach JPEG
- [ ] Vision + "too dark, warm it up" → `update_lights` intent
- [ ] Graceful null when export context unavailable

---

# PHASE C — Set Radio (Verbal ACKs)

## C1. Client: `src/director/set-radio.ts` (NEW)

```ts
export function speakAck(agent: string, note?: string): void
export function setRadioEnabled(enabled: boolean): void
```

`window.speechSynthesis` map:

| Agent | Default phrase |
|-------|----------------|
| Producer | "Copy." |
| DirectorsAssistant | "On it." |
| LightingTech | "Lighting." |
| AssetAnimator | "Moving." |
| VFXOperator | "FX." |

Wire in DirectorPod `onAgentStatus` when `status === 'active'`. Add mute toggle (speaker icon).

## C2. Acceptance criteria (Phase C)

- [ ] Active agent speaks once per command
- [ ] Mute toggle works
- [ ] No speech for local-only commands / disconnected state

---

# PHASE D — Hold / Action / Cut

## D1. Semantics

| Director says | Intent | Packet |
|---------------|--------|--------|
| hold, cut, freeze, stop | playback | `pause` |
| action, roll, go | playback | `play` |
| back to one, top of scene | playback | `seek 0` + `pause` |
| print the take | describe | log only |

## D2. Command queue gating (client, optional v1.1)

```ts
// agent-runtime.ts
let commandGate: 'open' | 'held' = 'open'
export function setCommandGate(state: 'open' | 'held'): void
```

When `held`: queue packets without applying until "continue" / "action".

**v1 minimum:** map hold/cut → pause only (no gate).

## D3. Acceptance criteria (Phase D)

- [ ] "Cut" pauses timeline
- [ ] "Action" resumes play
- [ ] (Stretch) packets during hold apply after "continue"

---

# PHASE E — Streaming Partial Intents (stretch)

Split text on `then`, `,`, `;` — parse/build/emit per clause without waiting for full sentence.

Reuse clause split from `fallback_parser` / `clause_handlers.py`.

## Acceptance criteria

- [ ] "add red box then enable bloom" — box packet before bloom
- [ ] Fallback clauses stream while LLM processes remainder

---

# TEST PLAN

## Server pytest

- `format_scene_brief` — empty, animated, heartbeat vs full
- describe intent → no packets
- `user_command.scene` overrides stale `scene_state.latest()`
- vision frame mock on anthropic path

## Manual browser

1. Spawn sphere, animate bounce, play timeline
2. "how's the bounce" — log cites sampled Y at currentTime
3. "?look too dark" — vision + lighting fix
4. "Cut" / "Action" transport
5. Hear ACK on spawn

---

# IMPLEMENTATION ORDER

```
Phase A (required) → Phase C (quick win) → Phase B → Phase D → Phase E
```

## Suggested commits (when asked)

1. `feat(director): expand scene_state with sampled poses and full command context`
2. `feat(director): describe intent and scene-aware LLM prompt`
3. `feat(director): viewfinder capture on vision triggers`
4. `feat(director): set radio verbal ACKs`
5. `feat(director): hold/action/cut playback semantics`

---

# CONSTRAINTS

- No raw `useEffect` — `useMountEffect` only
- Imports at top of file
- Minimal diff — don't refactor unrelated editor code
- Fallback parser must work without API keys
- No Gemini Live
- No full keyframes on heartbeat
- JPEG only on triggered `user_command`
- Update [[Command_Protocol]] with every schema change

---

# AGENT KICKOFF

Copy into Agent mode when ready to code:

```
Implement the Scene-Aware Director Mode brief:
docs/DirectorAI/06_Implementation_Brief/Scene_Aware_Director.md

Start with Phase A only. Keep Command_Protocol.md, schema.py, and protocol.ts
in sync. Run `uv run pytest` and `npm run lint`. Do not implement Phase B–E
until Phase A acceptance criteria pass.

Read ../brain/projects/Sikat.md for project context first.
```
