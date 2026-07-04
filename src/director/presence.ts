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
import type { Vec3 } from './protocol'

/** Choreography timings, shared so the runtime's paced apply and the scene's
 *  flight easing agree to the millisecond. */
export const CURSOR_FLIGHT_MS = 600 // glide from the previous spot to the target
export const CURSOR_WORK_MS = 220 // hover on target before the change commits
export const CURSOR_SETTLE_MS = 260 // linger after committing before the next task

export type CursorPhase = 'idle' | 'flying' | 'working' | 'settling'

export interface AgentMeta {
  /** Cursor tint + label background. */
  color: string
  /** Resting position, and the fallback target for scene-global commands
   *  (FX, playback) that have no spatial anchor. */
  station: Vec3
}

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

export function stationFor(agent: string): Vec3 {
  return AGENT_META[agent]?.station ?? [0, 4, 0]
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
}

interface PresenceState {
  agents: Record<string, AgentPresence>
  setActive: (agent: string, active: boolean) => void
  /** Point the cursor at a new target and (re)start its flight clock. */
  flyTo: (agent: string, target: Vec3, phase: CursorPhase) => void
  setPhase: (agent: string, phase: CursorPhase) => void
}

function seed(agent: string): AgentPresence {
  return {
    agent,
    active: false,
    phase: 'idle',
    target: stationFor(agent),
    moveStartedAt: 0,
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
  flyTo: (agent, target, phase) =>
    set((s) => patch(s, agent, { target, phase, moveStartedAt: performance.now() })),
  setPhase: (agent, phase) => set((s) => patch(s, agent, { phase })),
}))
