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
 *  flight easing agree to the millisecond. Calm directing sequence: announce →
 *  travel → note/apply → held check → soft exit. */
export const CURSOR_ANNOUNCE_MS = 200 // named label + spinner hold before travel
export const CURSOR_FLIGHT_MS = 450 // visible, natural glide to the target
export const CURSOR_INTENT_MS = 250 // deliberate identity handoff / initial drift
export const CURSOR_WORK_MS = 250 // readable action-note / apply beat
export const CURSOR_SETTLE_MS = 450 // check has time to register
export const CURSOR_MOTION_FADE_MS = 1100 // post-motion hold before soft fade
export const CURSOR_FADE_MS = 900 // post-work hold before soft fade

/**
 * How long the crew may be silent before the client stops waiting on them.
 *
 * This is the *whole* budget for a command, and every other layer derives from
 * it (`COMMAND_BUDGET_MS` in `link-health.ts` is the shared source, and the
 * server's own drain is set from the same number). They used to disagree —
 * cursors retired at 10s, the pod kept claiming work until 30s, and the server
 * gave up at 45s — which meant a slow command spent 20s looking abandoned and
 * could still land afterwards with nothing to attribute it to.
 */
export { COMMAND_BUDGET_MS as PENDING_RESPONSE_TIMEOUT_MS } from './link-health'

export type CursorPhase = 'idle' | 'intent' | 'flying' | 'working' | 'settling' | 'done'
export type IdleMode = 'none' | 'faded'

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
/** Station DIRECTIONS (unit-ish compass offsets) — real positions are derived
 *  from the live stage in agentMetaFor so everything scales to the 1m set. */
export const AGENT_META: Record<string, AgentMeta> = {
  AssetAnimator: { color: '#ff6b00', station: [0.83, 0, 0.55] },
  LightingTech: { color: '#ffd60a', station: [0.96, 0, 0.28] },
  VFXOperator: { color: '#bf5af2', station: [-0.87, 0, 0.5] },
  Producer: { color: '#30d158', station: [0.7, 0, 0.7] },
}

/** Crew hover at the rim of the set, roughly chest height on a tabletop stage. */
const STATION_RING_EXTRA = 0.6
const STATION_HEIGHT = 0.9

/** Producer speaks in the log/radio — never gets a stage cursor. */
export function cursorVisible(agent: string): boolean {
  return agent !== 'Producer'
}

/** Cursor order is stable so per-agent visual offsets (bob phase) stay put. */
export const AGENT_ORDER = Object.keys(AGENT_META)
export const CURSOR_AGENT_ORDER = AGENT_ORDER.filter(cursorVisible)

export function agentMetaFor(agent: string): AgentMeta {
  const perfMatch = agent.match(/^Agent(\d)$/i)
  if (perfMatch) {
    const n = parseInt(perfMatch[1], 10)
    const stage = useEditorStore.getState().stage
    const angle = ((n - 1) / 4) * Math.PI * 2 - Math.PI / 2
    const r = stage.radius + 0.5
    return {
      color: PERFORMER_PALETTE[(n - 1) % PERFORMER_PALETTE.length],
      station: [
        stage.position[0] + r * Math.cos(angle),
        stage.position[1] + 0.7,
        stage.position[2] + r * Math.sin(angle),
      ],
    }
  }
  const crew = AGENT_META[agent]
  if (crew) {
    const stage = useEditorStore.getState().stage
    const [dx, , dz] = crew.station
    const len = Math.hypot(dx, dz) || 1
    const r = stage.radius + STATION_RING_EXTRA
    return {
      color: crew.color,
      station: [
        stage.position[0] + (dx / len) * r,
        stage.position[1] + STATION_HEIGHT,
        stage.position[2] + (dz / len) * r,
      ],
    }
  }
  const stage = useEditorStore.getState().stage
  return { color: '#30d158', station: [stage.position[0], stage.position[1] + 1.1, stage.position[2]] }
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
  /**
   * One-shot point where this cursor turns on — the renderer snaps here, then
   * clears it. Set only by `appearAt`, and the renderer will not turn a cursor
   * on without it, so a first appearance can never inherit a stale `target`
   * from a previous command and fly in from a place it was never at.
   */
  appearFrom: Vec3 | null
  /** `performance.now()` when `target` last changed — the scene reads this to
   *  start a fresh flight ease from wherever the cursor currently is. */
  moveStartedAt: number
  /** Duration of the current flight, so short nudges and fast keyframe hops
   *  ease quicker than a full cross-stage glide. Set per move by `flyTo`. */
  moveDurationMs: number
  /** What the agent is doing right now, shown under the cursor label; null when idle. */
  note: string | null
  /** True only after an authoritative server preview/status or packet arrives. */
  noteConfirmed: boolean
  /** When set, the scene cursor tracks this object's live position each frame. */
  followObjectId: string | null
  idleMode: IdleMode
  lastTouchedObjectId: string | null
}

interface PresenceState {
  agents: Record<string, AgentPresence>
  setActive: (agent: string, active: boolean) => void
  fadeOut: (agent: string) => void
  /** Point the cursor at a new target and (re)start its flight clock. The
   *  optional duration lets callers pace a hop (defaults to a full flight). */
  flyTo: (agent: string, target: Vec3, phase: CursorPhase, durationMs?: number) => void
  /**
   * Turn a cursor on at a world point it is about to work at. The only way a
   * cursor becomes visible — and the position is required, so the renderer can
   * never fall back to a stale target and fly in from somewhere the cursor was
   * never at.
   */
  appearAt: (agent: string, position: Vec3) => void
  /** Clear the one-shot appearFrom after the renderer has snapped. */
  clearAppearFrom: (agent: string) => void
  setPhase: (agent: string, phase: CursorPhase) => void
  setNote: (agent: string, note: string | null, confirmed?: boolean) => void
  followObject: (agent: string, objectId: string | null) => void
  touchLastObject: (agent: string, objectId: string | null) => void
}

function seed(agent: string): AgentPresence {
  return {
    agent,
    active: false,
    phase: 'idle',
    target: stationFor(agent),
    appearFrom: null,
    moveStartedAt: 0,
    moveDurationMs: CURSOR_FLIGHT_MS,
    note: null,
    noteConfirmed: false,
    followObjectId: null,
    idleMode: 'none',
    lastTouchedObjectId: null,
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
  setActive: (agent, active) =>
    set((s) =>
      patch(s, agent, {
        active,
        idleMode: active ? 'none' : 'faded',
        note: active ? s.agents[agent]?.note ?? null : null,
        noteConfirmed: active ? s.agents[agent]?.noteConfirmed ?? false : false,
      })
    ),
  fadeOut: (agent) =>
    set((s) =>
      patch(s, agent, {
        active: false,
        idleMode: 'faded',
        phase: 'idle',
        note: null,
        appearFrom: null,
        followObjectId: null,
        lastTouchedObjectId: null,
      })
    ),
  flyTo: (agent, target, phase, durationMs = CURSOR_FLIGHT_MS) =>
    set((s) =>
      patch(s, agent, {
        target,
        phase,
        moveStartedAt: performance.now(),
        moveDurationMs: durationMs,
      })
    ),
  appearAt: (agent, position) =>
    set((s) =>
      patch(s, agent, {
        active: true,
        idleMode: 'none',
        target: position,
        appearFrom: position,
        phase: 'intent',
        moveStartedAt: performance.now(),
        moveDurationMs: 0,
        followObjectId: null,
      })
    ),
  clearAppearFrom: (agent) => set((s) => patch(s, agent, { appearFrom: null })),
  setPhase: (agent, phase) => set((s) => patch(s, agent, { phase })),
  setNote: (agent, note, confirmed = false) =>
    set((s) => {
      const previous = s.agents[agent] ?? seed(agent)
      const noteConfirmed =
        note == null
          ? false
          : confirmed || (previous.note === note && previous.noteConfirmed)
      return patch(s, agent, { note, noteConfirmed })
    }),
  followObject: (agent, objectId) => set((s) => patch(s, agent, { followObjectId: objectId })),
  touchLastObject: (agent, objectId) =>
    set((s) => patch(s, agent, { lastTouchedObjectId: objectId })),
}))
