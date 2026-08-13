/**
 * Director Mode wire contract — TypeScript mirror of server/app/schema.py.
 * Normative copy: docs/DirectorAI/03_PRD_Architecture/Command_Protocol.md.
 * Rotations are world-space euler XYZ in radians; colors are "#rrggbb".
 */

export type Vec3 = [number, number, number]
export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'

export interface Transition {
  durationSec: number
  easing: Easing
}

export interface Target {
  id?: string | null
  name?: string | null
}

/**
 * Where to put something, said as a relationship instead of a coordinate.
 *
 * The crew cannot reliably compute "the top of the pedestal" — that needs the
 * object's real bounds at the moment of placing, and any number the server
 * works out is stale as soon as the anchor animates or is rescaled. So the crew
 * names the relationship and the client resolves it against the live mesh.
 *
 * `position` remains the escape hatch for anything these relations don't cover.
 */
export type AnchorRelation = 'on' | 'above' | 'beside' | 'in_front_of' | 'behind'

export interface PlacementAnchor {
  target: Target
  relation: AnchorRelation
  /** Extra nudge applied after the relation resolves, in world metres. */
  offset?: Vec3 | null
}

export interface SpawnObjectPayload {
  primitive: 'box' | 'sphere' | 'cone' | 'cylinder' | 'torus' | 'plane' | 'text' | 'sneaker'
  id?: string | null
  name?: string | null
  color?: string | null
  text?: string | null
  position?: Vec3 | null
  rotation?: Vec3 | null
  scale?: Vec3 | null
  /** Placed relative to something already on set. Wins over `position`. */
  anchor?: PlacementAnchor | null
}

export interface RemoveObjectPayload {
  target: Target
}

export interface TransformObjectPayload {
  target: Target
  mode: 'absolute' | 'relative'
  position?: Vec3 | null
  rotation?: Vec3 | null
  scale?: Vec3 | null
  /** Moved relative to something else on set. Wins over `position`. */
  anchor?: PlacementAnchor | null
}

export interface AnimateObjectPayload {
  target: Target
  preset?: 'turnaround' | 'orbit' | 'bounce' | null
  motion?: string | null
  params?: Record<string, number> | null
  durationSec?: number | null
  /** When true, clip loops at end instead of stopping (say "loop the bounce"). */
  repeat?: boolean | null
}

export interface MoveCameraPayload {
  position?: Vec3 | null
  rotation?: Vec3 | null
  lookAt?: Vec3 | null
  lookAtTarget?: Target | null
  fov?: number | null
}

export interface UpdateLightsPayload {
  ambient?: { color?: string | null; intensity?: number | null } | null
  key?: { color?: string | null; intensity?: number | null; position?: Vec3 | null } | null
  background?: string | null
}

export interface SetMaterialPayload {
  target: Target
  color?: string | null
  emissive?: string | null
  emissiveIntensity?: number | null
  opacity?: number | null
}

export type FxSection = 'bloom' | 'pixelate' | 'cellShading' | 'glitch' | 'dither'

export interface UpdateFxPayload {
  section: FxSection
  patch: Record<string, number | boolean | null>
}

export interface SetKeyframesPayload {
  target?: Target | null // null targets the virtual camera
  property: 'position' | 'rotation' | 'scale' | 'fov'
  keyframes: Array<{ time: number; value: Vec3 }>
}

export interface PlaybackPayload {
  action: 'play' | 'pause' | 'seek' | 'record' | 'cut' | 'loop_on' | 'loop_off'
  time?: number | null
}

/** Generic Zustand store dispatch — args validated client-side only. */
export interface CallStoreActionPayload {
  action: string
  args: unknown[]
}

interface PacketBase {
  timestamp: number
  commandId?: string | null
  transition?: Transition | null
  target_agent: string
  /** When true, merge into existing motion instead of full cursor theater. */
  refinement?: boolean
  priorCommandId?: string | null
}

export type CommandPacket = PacketBase &
  (
    | { command: 'SPAWN_OBJECT'; payload: SpawnObjectPayload }
    | { command: 'REMOVE_OBJECT'; payload: RemoveObjectPayload }
    | { command: 'TRANSFORM_OBJECT'; payload: TransformObjectPayload }
    | { command: 'ANIMATE_OBJECT'; payload: AnimateObjectPayload }
    | { command: 'MOVE_CAMERA'; payload: MoveCameraPayload }
    | { command: 'UPDATE_LIGHTS'; payload: UpdateLightsPayload }
    | { command: 'SET_MATERIAL'; payload: SetMaterialPayload }
    | { command: 'UPDATE_FX'; payload: UpdateFxPayload }
    | { command: 'SET_KEYFRAMES'; payload: SetKeyframesPayload }
    | { command: 'PLAYBACK'; payload: PlaybackPayload }
    | { command: 'CALL_STORE_ACTION'; payload: CallStoreActionPayload }
  )

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export interface MaterialOverrideSnapshot {
  color?: string | null
  emissive?: string | null
  emissiveIntensity?: number | null
  opacity?: number | null
}

export interface KeyframeTrackSummary {
  property: 'position' | 'rotation' | 'scale' | 'fov'
  keyframeCount: number
}

export interface KeyframePoint {
  time: number
  value: Vec3
}

export interface KeyframeTrackFull {
  property: 'position' | 'rotation' | 'scale' | 'fov'
  keyframes: KeyframePoint[]
}

export type KeyframeTrack = KeyframeTrackSummary | KeyframeTrackFull

export interface SampledTransform {
  position: Vec3
  rotation: Vec3
  scale: Vec3
}

/** World-space axis-aligned bounds, sampled at snapshot time. */
export interface BoundsSnapshot {
  min: Vec3
  max: Vec3
}

export interface ObjectSnapshot {
  id: string
  name: string
  position: Vec3
  rotation: Vec3
  scale: Vec3
  sampled: SampledTransform
  keyframedProperties: string[]
  tracks: KeyframeTrack[]
  materialOverride?: MaterialOverrideSnapshot | null
  /** What it was created as — `box`, `sneaker`, `gltf`, … */
  primitive?: string | null
  /** The named motion authored on this object, when it came from the catalog. */
  motion?: string | null
  motionParams?: Record<string, number> | null
  motionLoop?: boolean | null
  /**
   * How much room it actually takes up.
   *
   * Without this the crew reads `scale (1.8,2.8,1.8)` and cannot tell a
   * cylinder from a box, how tall it stands, or where its top surface is — so
   * "put it on the pedestal" is unanswerable. Measured from the live mesh, so
   * it reflects the current pose rather than the base transform.
   */
  bounds?: BoundsSnapshot | null
}

export interface FxSummary {
  enabledSections: FxSection[]
  bloomStrength?: number | null
  ditherLevels?: number | null
}

export interface VirtualCameraSnapshot {
  position: Vec3
  rotation: Vec3
  fov: number
  sampled: SampledTransform
  sampledFov: number
  keyframedProperties: string[]
  tracks: KeyframeTrack[]
  fx: FxSummary
}

export interface SceneLightingSnapshot {
  ambient: { color?: string | null; intensity?: number | null }
  key: { color?: string | null; intensity?: number | null; position?: Vec3 | null }
  background: string
}

export interface StageSnapshot {
  position: Vec3
  radius: number
}

export interface SceneSnapshot {
  type: 'scene_state'
  timestamp: number
  mode: 'heartbeat' | 'full'
  currentTime: number
  duration: number
  isPlaying: boolean
  isRolling?: boolean
  /** Transport the brief could not see at all before: whether playback wraps,
   *  and where a clip ends. Without them "is it looping?" is unanswerable. */
  playbackLoop?: boolean
  clipLoopEnd?: number | null
  playOnceEnd?: number | null
  takeStartTime?: number
  selectedId?: string | null
  stage?: StageSnapshot
  objects: ObjectSnapshot[]
  virtualCamera: VirtualCameraSnapshot
  lighting: SceneLightingSnapshot
}

export interface SceneFrame {
  mime: 'image/jpeg'
  width: number
  height: number
  data: string
  capturedAt: number
}

export interface UserCommandMessage {
  type: 'user_command'
  timestamp: number
  text: string
  commandId?: string | null
  scene?: Omit<SceneSnapshot, 'type' | 'timestamp'> | null
  frame?: SceneFrame | null
}

/** Client's reply to one agent_tool_use round trip (SceneAgent loop). */
export interface AgentToolResultMessage {
  type: 'agent_tool_result'
  timestamp: number
  commandId: string
  requestId: string
  ok: boolean
  results: string[]
  scene?: SceneSnapshot | null
  frame?: SceneFrame | null
}

/** User stopped an in-flight SceneAgent session (e.g. said "cut"). */
export interface AgentAbortMessage {
  type: 'agent_abort'
  timestamp: number
  commandId: string
}

/**
 * Liveness probe. `scene_state` only goes out when the snapshot changes, so an
 * untouched set is silent and a half-open socket is undetectable without this.
 * See `link-health.ts` for the policy and `socket.ts` for the timer.
 */
export interface PingMessage {
  type: 'ping'
  timestamp: number
}

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

/**
 * Answer to `ping`. Carries nothing: its arrival is the entire payload, and
 * `socket.ts` records liveness from the raw frame before parsing, so this never
 * needs to reach `parseServerMessage`.
 */
export interface PongMessage {
  type: 'pong'
  timestamp: number
}

export interface AgentCommandMessage {
  type: 'agent_command'
  timestamp: number
  packet: CommandPacket
}

export interface AgentLogMessage {
  type: 'agent_log'
  timestamp: number
  agent: string
  level: 'info' | 'warn' | 'error'
  message: string
  forCommandId?: string | null
  /** Machine-readable class: 'miss' = didn't understand; 'reply' = direct answer. */
  kind?: 'miss' | 'reply' | null
}

/**
 * Cursor-presence lifecycle. `active` = the agent picked up work (its cursor
 * should appear); `idle` = it stood down (cursor may fade once its client-side
 * queue drains). The cursor's 3D target is derived client-side from the
 * `agent_command` packets that stream alongside these events.
 */
export interface AgentStatusMessage {
  type: 'agent_status'
  timestamp: number
  agent: string
  status: 'active' | 'idle'
  forCommandId?: string | null
  note?: string | null
}

export type IntentPreviewConfidence = 'guess' | 'grammar' | 'llm_partial'

export interface IntentPreviewMessage {
  type: 'intent_preview'
  timestamp: number
  commandId: string
  agent: string
  target?: string | null
  action?: string | null
  motion?: string | null
  note: string
  confidence: IntentPreviewConfidence
  /** Spatial payload for ghost previews — what the crew understood, pre-commit. */
  position?: Vec3 | null
  rotation?: Vec3 | null
  scale?: Vec3 | null
  mode?: 'absolute' | 'relative' | null
  primitive?: SpawnObjectPayload['primitive'] | null
  color?: string | null
}

export interface ErrorMessage {
  type: 'error'
  timestamp: number
  message: string
  forCommandId?: string | null
}

export type CancelReason = 'supersede' | 'stop' | 'amend'

export interface CommandCancelMessage {
  type: 'command_cancel'
  timestamp: number
  commandId: string
  supersededBy?: string | null
  target?: Target | null
  command?: string | null
  reason?: CancelReason | null
}

export type SuggestionKind = 'observation' | 'suggestion' | 'reaction'

export interface AgentSuggestionMessage {
  type: 'agent_suggestion'
  timestamp: number
  suggestionId: string
  agent: string
  text: string
  suggestedCommand?: string | null
  subjectObject?: string | null
  kind: SuggestionKind
}

export interface AgentQuestionMessage {
  type: 'agent_question'
  timestamp: number
  agent: string
  commandId: string
  question: string
  options: string[]
}

export type PlanUpdateStatus =
  | 'planning'
  | 'escalating'
  | 'step_start'
  | 'step_done'
  | 'adjusting'
  | 'pitched'
  | 'done'

export type PlanMode = 'execute' | 'pitch' | 'amend' | 'surprise'

export interface PlanUpdateMessage {
  type: 'plan_update'
  timestamp: number
  commandId: string
  status: PlanUpdateStatus
  say?: string | null
  mode?: PlanMode | null
  stepIndex?: number | null
  stepsTotal?: number | null
  stepLabel?: string | null
}

export type AgentToolName = 'run_commands' | 'call_store_action' | 'get_scene' | 'capture_frame'

/** One SceneAgent tool invocation for this client to execute and answer. */
export interface AgentToolUseMessage {
  type: 'agent_tool_use'
  timestamp: number
  commandId: string
  requestId: string
  tool: AgentToolName
  payload: Record<string, unknown>
}

export type ServerMessage =
  | AgentCommandMessage
  | AgentLogMessage
  | AgentStatusMessage
  | IntentPreviewMessage
  | CommandCancelMessage
  | AgentQuestionMessage
  | AgentSuggestionMessage
  | PlanUpdateMessage
  | AgentToolUseMessage
  | ErrorMessage

/** Cheap structural check — the server already pydantic-validated the packet. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'object' || raw === null) return null
  const msg = raw as { type?: unknown }
  if (msg.type === 'agent_command' && typeof (raw as AgentCommandMessage).packet === 'object')
    return raw as AgentCommandMessage
  if (msg.type === 'agent_log' && typeof (raw as AgentLogMessage).message === 'string')
    return raw as AgentLogMessage
  if (msg.type === 'agent_status' && typeof (raw as AgentStatusMessage).agent === 'string')
    return raw as AgentStatusMessage
  if (msg.type === 'intent_preview' && typeof (raw as IntentPreviewMessage).note === 'string')
    return raw as IntentPreviewMessage
  if (msg.type === 'command_cancel' && typeof (raw as CommandCancelMessage).commandId === 'string')
    return raw as CommandCancelMessage
  if (msg.type === 'agent_question' && typeof (raw as AgentQuestionMessage).question === 'string')
    return raw as AgentQuestionMessage
  if (msg.type === 'plan_update' && typeof (raw as PlanUpdateMessage).commandId === 'string')
    return raw as PlanUpdateMessage
  if (
    msg.type === 'agent_tool_use' &&
    typeof (raw as AgentToolUseMessage).requestId === 'string' &&
    typeof (raw as AgentToolUseMessage).tool === 'string'
  )
    return raw as AgentToolUseMessage
  if (
    msg.type === 'agent_suggestion' &&
    typeof (raw as AgentSuggestionMessage).text === 'string' &&
    typeof (raw as AgentSuggestionMessage).suggestionId === 'string'
  )
    return raw as AgentSuggestionMessage
  if (msg.type === 'error' && typeof (raw as ErrorMessage).message === 'string')
    return raw as ErrorMessage
  return null
}
