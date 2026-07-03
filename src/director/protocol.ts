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
  preset: 'turnaround' | 'orbit' | 'bounce'
  durationSec?: number | null
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
  action: 'play' | 'pause' | 'seek'
  time?: number | null
}

interface PacketBase {
  timestamp: number
  commandId?: string | null
  transition?: Transition | null
  target_agent: string
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

export interface ObjectSnapshot {
  id: string
  name: string
  position: Vec3
  rotation: Vec3
  scale: Vec3
  keyframedProperties: string[]
}

export interface SceneSnapshot {
  type: 'scene_state'
  timestamp: number
  objects: ObjectSnapshot[]
  camera: { position: Vec3; rotation: Vec3; fov: number }
  duration: number
  isPlaying: boolean
}

export interface UserCommandMessage {
  type: 'user_command'
  timestamp: number
  text: string
  commandId: string
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

export interface ErrorMessage {
  type: 'error'
  timestamp: number
  message: string
  forCommandId?: string | null
}

export type ServerMessage = AgentCommandMessage | AgentLogMessage | ErrorMessage

/** Cheap structural check — the server already pydantic-validated the packet. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'object' || raw === null) return null
  const msg = raw as { type?: unknown }
  if (msg.type === 'agent_command' && typeof (raw as AgentCommandMessage).packet === 'object')
    return raw as AgentCommandMessage
  if (msg.type === 'agent_log' && typeof (raw as AgentLogMessage).message === 'string')
    return raw as AgentLogMessage
  if (msg.type === 'error' && typeof (raw as ErrorMessage).message === 'string')
    return raw as ErrorMessage
  return null
}
