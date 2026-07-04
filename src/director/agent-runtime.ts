/**
 * Per-agent execution queue — turns the server's packet stream into paced work.
 *
 * Cursors fly to the target, the change commits, then the cursor **follows**
 * the affected object while it animates (main + viewfinder show the real motion).
 * No fake path-tracing or trail drawing.
 */
import { applyCommandPacket, resolveTarget } from './command-applier'
import { packetTargetPosition } from './cursor-targets'
import {
  presenceStore,
  stationFor,
  CURSOR_FLIGHT_MS,
  CURSOR_WORK_MS,
  CURSOR_SETTLE_MS,
} from './presence'
import { useEditorStore } from '../store'
import type { CommandPacket, Target } from './protocol'

type LogLevel = 'info' | 'warn' | 'error'
type Logger = (agent: string, text: string, level: LogLevel) => void

let logger: Logger = () => {}

export function setRuntimeLogger(fn: Logger): void {
  logger = fn
}

const queues = new Map<string, CommandPacket[]>()
const running = new Set<string>()
const pendingIdle = new Set<string>()

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const dist = (a: [number, number, number], b: [number, number, number]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

const MS_PER_UNIT = 95
function flightDurationTo(agent: string, target: [number, number, number]): number {
  const current = presenceStore.getState().agents[agent]?.target ?? stationFor(agent)
  return clamp(dist(current, target) * MS_PER_UNIT, 120, CURSOR_FLIGHT_MS)
}

function noteForPacket(packet: CommandPacket): string {
  switch (packet.command) {
    case 'SPAWN_OBJECT':
      return `spawning ${packet.payload.primitive}`
    case 'REMOVE_OBJECT':
      return 'removing'
    case 'TRANSFORM_OBJECT':
      return 'moving'
    case 'ANIMATE_OBJECT':
      return `${packet.payload.preset}`
    case 'MOVE_CAMERA':
      return 'framing'
    case 'UPDATE_LIGHTS':
      return 'lighting'
    case 'SET_MATERIAL':
      return 'material'
    case 'UPDATE_FX':
      return `${packet.payload.section}`
    case 'SET_KEYFRAMES':
      return 'keyframes'
    case 'PLAYBACK':
      return 'cueing'
    default:
      return 'working'
  }
}

function resolveObjectId(target: Target | null | undefined): string | null {
  if (!target) return null
  return resolveTarget(target)?.id ?? null
}

/** Object id the agent should track after this packet commits. */
function followObjectIdForPacket(packet: CommandPacket): string | null {
  switch (packet.command) {
    case 'SPAWN_OBJECT': {
      const st = useEditorStore.getState()
      const needle = (packet.payload.name ?? packet.payload.id ?? '').toLowerCase()
      if (needle) {
        const byName = st.objects.find((o) => o.name.toLowerCase() === needle)
        if (byName) return byName.id
      }
      return st.objects.at(-1)?.id ?? null
    }
    case 'REMOVE_OBJECT':
    case 'TRANSFORM_OBJECT':
    case 'ANIMATE_OBJECT':
    case 'SET_MATERIAL':
    case 'SET_KEYFRAMES':
      return resolveObjectId(packet.payload.target)
    default:
      return null
  }
}

export function enqueuePacket(packet: CommandPacket): void {
  const agent = packet.target_agent
  pendingIdle.delete(agent)
  const queue = queues.get(agent) ?? []
  queue.push(packet)
  queues.set(agent, queue)
  presenceStore.getState().setActive(agent, true)
  if (!running.has(agent)) void runAgent(agent)
}

export function markAgentActive(agent: string, note?: string | null): void {
  const presence = presenceStore.getState()
  presence.setActive(agent, true)
  if (note != null) presence.setNote(agent, note)
}

export function markAgentIdle(agent: string): void {
  const queued = queues.get(agent)?.length ?? 0
  if (!running.has(agent) && queued === 0) {
    scheduleAgentFadeOut(agent)
  } else {
    pendingIdle.add(agent)
  }
}

/** Keep the cursor on a moving object until playback stops, then fade out. */
function scheduleAgentFadeOut(agent: string): void {
  const presence = presenceStore.getState()
  const followId = presence.agents[agent]?.followObjectId
  if (followId && useEditorStore.getState().isPlaying) {
    void deferIdleAfterPlayback(agent)
    return
  }
  presence.followObject(agent, null)
  presence.setActive(agent, false)
}

async function deferIdleAfterPlayback(agent: string): Promise<void> {
  while (useEditorStore.getState().isPlaying) {
    await sleep(80)
  }
  if (running.has(agent) || (queues.get(agent)?.length ?? 0) > 0) return
  const presence = presenceStore.getState()
  presence.followObject(agent, null)
  presence.setActive(agent, false)
}

async function runAgent(agent: string): Promise<void> {
  running.add(agent)
  const presence = presenceStore.getState()
  const queue = queues.get(agent)!

  while (queue.length > 0) {
    const packet = queue.shift()!
    presence.followObject(agent, null)
    presence.setNote(agent, noteForPacket(packet))

    const target = packetTargetPosition(packet)
    const flightMs = flightDurationTo(agent, target)
    presence.flyTo(agent, target, 'flying', flightMs)
    await sleep(flightMs)

    presence.setPhase(agent, 'working')
    await sleep(CURSOR_WORK_MS)

    try {
      const result = applyCommandPacket(packet)
      logger(agent, `${packet.command}: ${result}`, 'info')
      const followId = followObjectIdForPacket(packet)
      if (followId) {
        presence.followObject(agent, followId)
        presence.setPhase(agent, 'working')
      }
    } catch (e) {
      logger(agent, `${packet.command} failed: ${e instanceof Error ? e.message : e}`, 'error')
    }

    presence.setPhase(agent, 'settling')
    presence.setNote(agent, null)
    await sleep(CURSOR_SETTLE_MS)
  }

  running.delete(agent)
  presence.setPhase(agent, 'idle')
  if (pendingIdle.has(agent)) {
    pendingIdle.delete(agent)
    scheduleAgentFadeOut(agent)
  }
}

export function resetAgentRuntime(): void {
  queues.clear()
  running.clear()
  pendingIdle.clear()
}
