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
import { sampleObjectAtTime } from './scene-state-sync'
import type { Vec3 } from './protocol'

/** Choreography timings, shared so the runtime's paced apply and the scene's
 *  flight easing agree to the millisecond. Calm directing sequence: announce →
 *  travel → note/apply → held check → soft exit. */
export const CURSOR_ANNOUNCE_MS = 350 // named label + spinner hold before travel
export const CURSOR_FLIGHT_MS = 750 // visible, natural glide to the target
export const CURSOR_INTENT_MS = 350 // deliberate identity handoff / initial drift
export const CURSOR_WORK_MS = 350 // readable action-note / apply beat
export const CURSOR_SETTLE_MS = 800 // check has time to register
export const CURSOR_MOTION_FADE_MS = 1100 // post-motion hold before soft fade
export const CURSOR_FADE_MS = 900 // post-work hold before soft fade
/** Wait before showing the anonymous pending cursor — skips flash on fast
 *  chitchat / describe-only replies that never need a stage cursor. */
export const PENDING_SHOW_DELAY_MS = 400
export const PENDING_RESPONSE_TIMEOUT_MS = 10_000 // clear a silent server request

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
export const AGENT_META: Record<string, AgentMeta> = {
  AssetAnimator: { color: '#ff6b00', station: [3, 1.8, 2] },
  LightingTech: { color: '#ffd60a', station: [3.4, 2.7, 1] },
  VFXOperator: { color: '#bf5af2', station: [-2.6, 2.4, 1.5] },
  Producer: { color: '#30d158', station: [1.5, 2.4, 1.5] },
}

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

/** Where an anonymous pending cursor appears before the server names an agent. */
export function pendingAnchorPosition(): Vec3 {
  const st = useEditorStore.getState()
  if (st.selectedId) {
    const obj = st.objects.find((o) => o.id === st.selectedId)
    if (obj) {
      const sampled = sampleObjectAtTime(obj, st.currentTime)
      return [sampled.position[0], sampled.position[1], sampled.position[2]]
    }
  }
  const stage = st.stage
  return [stage.position[0], stage.position[1] + 2.2, stage.position[2]]
}

export interface AgentPresence {
  agent: string
  /** Cursor should be on stage (announced by the server, held until the
   *  client-side queue drains). */
  active: boolean
  phase: CursorPhase
  /** Scene point the cursor is addressing. */
  target: Vec3
  /** One-shot spawn point for pending→named handoff; renderer snaps here then clears. */
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

export interface PendingCursor {
  position: Vec3
}

interface PresenceState {
  agents: Record<string, AgentPresence>
  pending: Record<string, PendingCursor>
  setActive: (agent: string, active: boolean) => void
  fadeOut: (agent: string) => void
  /** Point the cursor at a new target and (re)start its flight clock. The
   *  optional duration lets callers pace a hop (defaults to a full flight). */
  flyTo: (agent: string, target: Vec3, phase: CursorPhase, durationMs?: number) => void
  /** Snap a newly-appearing agent cursor to a world point (pending handoff). */
  appearAt: (agent: string, position: Vec3) => void
  /** Clear the one-shot appearFrom after the renderer has snapped. */
  clearAppearFrom: (agent: string) => void
  setPhase: (agent: string, phase: CursorPhase) => void
  setNote: (agent: string, note: string | null, confirmed?: boolean) => void
  followObject: (agent: string, objectId: string | null) => void
  touchLastObject: (agent: string, objectId: string | null) => void
  showPending: (commandId: string, position: Vec3) => void
  clearPending: (commandId: string) => void
  pendingPosition: (commandId: string) => Vec3 | null
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

export const presenceStore = create<PresenceState>((set, get) => ({
  agents: {},
  pending: {},
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
  showPending: (commandId, position) =>
    set((s) => ({
      pending: { ...s.pending, [commandId]: { position } },
    })),
  clearPending: (commandId) =>
    set((s) => {
      if (!(commandId in s.pending)) return s
      const { [commandId]: _, ...rest } = s.pending
      return { pending: rest }
    }),
  pendingPosition: (commandId) => get().pending[commandId]?.position ?? null,
}))
