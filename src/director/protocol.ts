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

export interface SpawnObjectPayload {
  primitive: 'box' | 'sphere' | 'cone' | 'cylinder' | 'torus' | 'plane' | 'text'
  id?: string | null
  name?: string | null
  color?: string | null
  text?: string | null
  position?: Vec3 | null
  rotation?: Vec3 | null
  scale?: Vec3 | null
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

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

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

export interface AgentQuestionMessage {
  type: 'agent_question'
  timestamp: number
  agent: string
  commandId: string
  question: string
  options: string[]
}

export type ServerMessage =
  | AgentCommandMessage
  | AgentLogMessage
  | AgentStatusMessage
  | IntentPreviewMessage
  | CommandCancelMessage
  | AgentQuestionMessage
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
  if (msg.type === 'error' && typeof (raw as ErrorMessage).message === 'string')
    return raw as ErrorMessage
  return null
}
