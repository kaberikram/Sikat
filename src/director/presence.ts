/**
 * Agent-cursor presence store — the Figma-multiplayer layer for the AI crew.
 *
 * Ownership: written exclusively by `src/director/` (the agent runtime), read
 * by `src/scene/` (the cursor renderer). This respects the repo invariant that
 * only scene/ touches the renderer while director code mutates stores. The
 * store holds *semantic* cursor state (which agent is working, where it is
 * addressing, when the current move began); the scene turns that into eased 3D
 * positions each frame.
 */
import { create } from 'zustand'
import { useEditorStore } from '../store'
import type { Vec3 } from './protocol'

/** Choreography timings, shared so the runtime's paced apply and the scene's
 *  flight easing agree to the millisecond. */
export const CURSOR_FLIGHT_MS = 450 // glide from the previous spot to the target
export const CURSOR_INTENT_MS = 200 // fast drift during pre-parse acknowledgment
export const CURSOR_WORK_MS = 120 // hover on target before the change commits
export const CURSOR_SETTLE_MS = 140 // linger after committing before the next task

export type CursorPhase = 'idle' | 'intent' | 'flying' | 'working' | 'settling'

export interface AgentMeta {
  /** Cursor tint + label background. */
  color: string
  /** Resting position, and the fallback target for scene-global commands
   *  (FX, playback) that have no spatial anchor. */
  station: Vec3
}

const PERFORMER_PALETTE = ['#ff6b00', '#0a84ff', '#30d158', '#bf5af2']

/** The crew that gets a cursor. The Director's Assistant only parses text, so
 *  it never shows up on stage. */
export const AGENT_META: Record<string, AgentMeta> = {
  AssetAnimator: { color: '#ff6b00', station: [3, 1.8, 2] },
  LightingTech: { color: '#ffd60a', station: [3.4, 2.7, 1] },
  VFXOperator: { color: '#bf5af2', station: [-2.6, 2.4, 1.5] },
  Producer: { color: '#30d158', station: [1.5, 2.4, 1.5] },
}

/** Cursor order is stable so per-agent visual offsets (bob phase) stay put. */
export const AGENT_ORDER = Object.keys(AGENT_META)

export function agentMetaFor(agent: string): AgentMeta {
  const perfMatch = agent.match(/^Agent(\d)$/i)
  if (perfMatch) {
    const n = parseInt(perfMatch[1], 10)
    const stage = useEditorStore.getState().stage
    const angle = ((n - 1) / 4) * Math.PI * 2 - Math.PI / 2
    const r = stage.radius + 1.2
    return {
      color: PERFORMER_PALETTE[(n - 1) % PERFORMER_PALETTE.length],
      station: [
        stage.position[0] + r * Math.cos(angle),
        stage.position[1] + 1.8,
        stage.position[2] + r * Math.sin(angle),
      ],
    }
  }
  const crew = AGENT_META[agent]
  if (crew) {
    const stage = useEditorStore.getState().stage
    return {
      color: crew.color,
      station: [
        stage.position[0] + crew.station[0],
        stage.position[1] + crew.station[1],
        stage.position[2] + crew.station[2],
      ],
    }
  }
  const stage = useEditorStore.getState().stage
  return { color: '#888888', station: [stage.position[0], stage.position[1] + 4, stage.position[2]] }
}

export function stationFor(agent: string): Vec3 {
  return agentMetaFor(agent).station
}

export interface AgentPresence {
  agent: string
  /** Cursor should be on stage (announced by the server, held until the
   *  client-side queue drains). */
  active: boolean
  phase: CursorPhase
  /** Scene point the cursor is addressing. */
  target: Vec3
  /** `performance.now()` when `target` last changed — the scene reads this to
   *  start a fresh flight ease from wherever the cursor currently is. */
  moveStartedAt: number
  /** Duration of the current flight, so short nudges and fast keyframe hops
   *  ease quicker than a full cross-stage glide. Set per move by `flyTo`. */
  moveDurationMs: number
  /** What the agent is doing right now, shown under the cursor label; null when idle. */
  note: string | null
  /** When set, the scene cursor tracks this object's live position each frame. */
  followObjectId: string | null
}

interface PresenceState {
  agents: Record<string, AgentPresence>
  setActive: (agent: string, active: boolean) => void
  /** Point the cursor at a new target and (re)start its flight clock. The
   *  optional duration lets callers pace a hop (defaults to a full flight). */
  flyTo: (agent: string, target: Vec3, phase: CursorPhase, durationMs?: number) => void
  setPhase: (agent: string, phase: CursorPhase) => void
  setNote: (agent: string, note: string | null) => void
  followObject: (agent: string, objectId: string | null) => void
}

function seed(agent: string): AgentPresence {
  return {
    agent,
    active: false,
    phase: 'idle',
    target: stationFor(agent),
    moveStartedAt: 0,
    moveDurationMs: CURSOR_FLIGHT_MS,
    note: null,
    followObjectId: null,
  }
}

function patch(
  state: PresenceState,
  agent: string,
  updates: Partial<AgentPresence>
): Pick<PresenceState, 'agents'> {
  const prev = state.agents[agent] ?? seed(agent)
  return { agents: { ...state.agents, [agent]: { ...prev, ...updates } } }
}

export const presenceStore = create<PresenceState>((set) => ({
  agents: {},
  setActive: (agent, active) => set((s) => patch(s, agent, { active })),
  flyTo: (agent, target, phase, durationMs = CURSOR_FLIGHT_MS) =>
    set((s) =>
      patch(s, agent, {
        target,
        phase,
        moveStartedAt: performance.now(),
        moveDurationMs: durationMs,
      })
    ),
  setPhase: (agent, phase) => set((s) => patch(s, agent, { phase })),
  setNote: (agent, note) => set((s) => patch(s, agent, { note })),
  followObject: (agent, objectId) => set((s) => patch(s, agent, { followObjectId: objectId })),
}))
