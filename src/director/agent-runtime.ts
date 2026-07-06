/**
 * Per-agent execution queue — turns the server's packet stream into paced work.
 *
 * Cursors fly to the target, the change commits, then the cursor **follows**
 * the affected object while it animates (main + viewfinder show the real motion).
 * No fake path-tracing or trail drawing.
 */
import { applyCommandPacket, cancelCommandPacket, resolveTarget } from './command-applier'
import { packetTargetPosition } from './cursor-targets'
import { guessIntent, type IntentGuess } from './intent-guess'
import { markFirstApply, markFirstCursorMove, markFirstPreview, markFirstRefinement } from './latency'
import {
  presenceStore,
  stationFor,
  CURSOR_FLIGHT_MS,
  CURSOR_INTENT_MS,
  CURSOR_WORK_MS,
  CURSOR_SETTLE_MS,
  CURSOR_LINGER_MS,
} from './presence'
import { useEditorStore } from '../store'
import type { CommandPacket, CommandCancelMessage, IntentPreviewMessage, AgentSuggestionMessage, Target, Vec3 } from './protocol'

type LogLevel = 'info' | 'warn' | 'error'
type Logger = (agent: string, text: string, level: LogLevel) => void

let logger: Logger = () => {}

export function setRuntimeLogger(fn: Logger): void {
  logger = fn
}

const queues = new Map<string, CommandPacket[]>()
const running = new Set<string>()
const pendingIdle = new Set<string>()
const inFlight = new Map<string, AbortController>()
const lingerTimers = new Map<string, ReturnType<typeof setTimeout>>()
const suggestionGlance = new Set<string>()

function clearLingerTimer(agent: string): void {
  const t = lingerTimers.get(agent)
  if (t) clearTimeout(t)
  lingerTimers.delete(agent)
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true }
    )
  })
}
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
      return `${packet.payload.motion ?? packet.payload.preset ?? 'animating'}`
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

/** Object id this packet addresses, for barge-in supersede matching. Only
 *  commands with a resolvable object target participate — scene-global
 *  commands (spawn, camera, lights, fx, playback) never supersede. */
function packetSupersedeTargetId(packet: CommandPacket): string | null {
  switch (packet.command) {
    case 'TRANSFORM_OBJECT':
    case 'ANIMATE_OBJECT':
    case 'SET_MATERIAL':
      return resolveObjectId(packet.payload.target)
    case 'SET_KEYFRAMES':
      return resolveObjectId(packet.payload.target ?? null)
    default:
      return null
  }
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

export function cancelCommand(msg: CommandCancelMessage): void {
  cancelCommandPacket(msg)

  for (const [key, controller] of inFlight) {
    if (key.startsWith(`${msg.commandId}:`)) controller.abort()
  }

  for (const [agent, queue] of queues) {
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].commandId === msg.commandId) queue.splice(i, 1)
    }
    if (queue.length === 0) queues.delete(agent)
  }
}

export function enqueuePacket(packet: CommandPacket): void {
  const agent = packet.target_agent
  clearLingerTimer(agent)
  const presence = presenceStore.getState()
  presence.setActive(agent, true)
  pendingIdle.delete(agent)
  const queue = queues.get(agent) ?? []

  // Barge-in v1: a newer command for the same object + command type
  // supersedes any not-yet-applied packet still waiting in this agent's
  // queue, so a fresh correction doesn't wait behind stale queued work. The
  // in-flight packet (already shifted off the queue) is unaffected — its
  // flight/work sleep still plays out (≤ ~600ms).
  const targetId = packetSupersedeTargetId(packet)
  if (targetId) {
    for (let i = queue.length - 1; i >= 0; i--) {
      const queued = queue[i]
      if (
        queued.command === packet.command &&
        queued.commandId !== packet.commandId &&
        packetSupersedeTargetId(queued) === targetId
      ) {
        queue.splice(i, 1)
      }
    }
  }

  queue.push(packet)
  queues.set(agent, queue)
  if (!running.has(agent)) void runAgent(agent)
}

export function markAgentActive(agent: string, note?: string | null): void {
  const presence = presenceStore.getState()
  presence.setActive(agent, true)
  if (note != null) presence.setNote(agent, note)
}

function targetPositionForGuess(guess: IntentGuess): Vec3 {
  if (guess.targetPosition) return guess.targetPosition
  if (guess.targetObjectId) {
    const obj = useEditorStore.getState().objects.find((o) => o.id === guess.targetObjectId)
    if (obj) return obj.position
  }
  if (guess.targetName) {
    const obj = resolveTarget({ name: guess.targetName })
    if (obj) return obj.position
  }
  return stationFor(guess.agent)
}

/** Instant client-side reaction before server parse (Phase F1). */
export function applyClientIntentGuess(text: string, commandId?: string | null): void {
  const guess = guessIntent(text)
  if (!guess) return
  markFirstCursorMove(commandId)
  const presence = presenceStore.getState()
  presence.setActive(guess.agent, true)
  presence.setNote(guess.agent, guess.note)
  presence.flyTo(guess.agent, targetPositionForGuess(guess), 'intent', CURSOR_INTENT_MS)
}

/** Authoritative server preview — supersedes client guess (Phase F2). */
export function applyIntentPreview(msg: IntentPreviewMessage): void {
  markFirstPreview(msg.commandId)
  const presence = presenceStore.getState()
  presence.setActive(msg.agent, true)
  presence.setNote(msg.agent, msg.note)
  let target: Vec3 = stationFor(msg.agent)
  if (msg.target) {
    const obj = resolveTarget({ name: msg.target })
    if (obj) target = obj.position
  }
  markFirstCursorMove(msg.commandId)
  presence.flyTo(msg.agent, target, 'intent', CURSOR_INTENT_MS)
}

export function markAgentIdle(agent: string): void {
  if (suggestionGlance.has(agent)) return
  const queued = queues.get(agent)?.length ?? 0
  if (!running.has(agent) && queued === 0) {
    scheduleAgentFadeOut(agent)
  } else {
    pendingIdle.add(agent)
  }
}

/** Proactive crew suggestion — cursor glance without packet queue (Phase A4). */
export function reactToSuggestion(msg: AgentSuggestionMessage): void {
  const agent = msg.agent
  suggestionGlance.add(agent)
  markAgentActive(agent, msg.text)
  let target: Vec3 = stationFor(agent)
  if (msg.subjectObject) {
    const obj = resolveTarget({ name: msg.subjectObject })
    if (obj) target = obj.position
  }
  const presence = presenceStore.getState()
  presence.flyTo(agent, target, 'intent', CURSOR_INTENT_MS)
  if (msg.subjectObject) {
    const id = resolveTarget({ name: msg.subjectObject })?.id
    if (id) {
      presence.followObject(agent, id)
      presence.touchLastObject(agent, id)
    }
  }
  setTimeout(() => {
    suggestionGlance.delete(agent)
    if (!running.has(agent) && (queues.get(agent)?.length ?? 0) === 0) {
      scheduleAgentFadeOut(agent)
    }
  }, 3000)
}

/** Keep the cursor on a moving object until playback stops, then linger at station. */
function scheduleAgentFadeOut(agent: string): void {
  const presence = presenceStore.getState()
  const followId = presence.agents[agent]?.followObjectId
  if (followId && useEditorStore.getState().isPlaying) {
    void deferIdleAfterPlayback(agent)
    return
  }
  const lastTouched = presence.agents[agent]?.lastTouchedObjectId ?? followId
  presence.enterLinger(agent, lastTouched)
  clearLingerTimer(agent)
  lingerTimers.set(
    agent,
    setTimeout(() => {
      presenceStore.getState().fadeOut(agent)
      lingerTimers.delete(agent)
    }, CURSOR_LINGER_MS)
  )
}

async function deferIdleAfterPlayback(agent: string): Promise<void> {
  while (useEditorStore.getState().isPlaying) {
    await sleep(80)
  }
  if (running.has(agent) || (queues.get(agent)?.length ?? 0) > 0) return
  scheduleAgentFadeOut(agent)
}

async function runAgent(agent: string): Promise<void> {
  running.add(agent)
  const presence = presenceStore.getState()
  const queue = queues.get(agent)!

  while (queue.length > 0) {
    const packet = queue.shift()!
    const objectId = packetSupersedeTargetId(packet)
    const flightKey = `${packet.commandId ?? 'local'}:${packet.command}:${objectId ?? 'global'}`
    const abort = new AbortController()
    inFlight.set(flightKey, abort)

    const serverNote = presence.agents[agent]?.note
    presence.setNote(agent, serverNote ?? noteForPacket(packet))

    try {
      if (packet.refinement) {
        try {
          const result = applyCommandPacket(packet)
          logger(agent, `${packet.command} (refine): ${result}`, 'info')
          const refineElapsed = markFirstRefinement(packet.commandId)
          if (refineElapsed != null) logger('SYSTEM', `⏱ first refine ${refineElapsed.toFixed(2)}s`, 'info')
          const followId = followObjectIdForPacket(packet)
        if (followId) {
          presence.followObject(agent, followId)
          presence.touchLastObject(agent, followId)
          presence.setPhase(agent, 'working')
        }
        } catch (e) {
          logger(agent, `${packet.command} refine failed: ${e instanceof Error ? e.message : e}`, 'error')
        }
        continue
      }

      presence.followObject(agent, null)
      const target = packetTargetPosition(packet)
      const flightMs = flightDurationTo(agent, target)
      const hotApply =
        packet.command === 'ANIMATE_OBJECT' || packet.command === 'TRANSFORM_OBJECT'

      presence.flyTo(agent, target, 'flying', flightMs)

      const applyPacket = () => {
        try {
          const result = applyCommandPacket(packet)
          logger(agent, `${packet.command}: ${result}`, 'info')
          const applyElapsed = markFirstApply(packet.commandId)
          if (applyElapsed != null) logger('SYSTEM', `⏱ first apply ${applyElapsed.toFixed(2)}s`, 'info')
          const followId = followObjectIdForPacket(packet)
        if (followId) {
          presence.followObject(agent, followId)
          presence.touchLastObject(agent, followId)
          presence.setPhase(agent, 'working')
        }
        } catch (e) {
          logger(agent, `${packet.command} failed: ${e instanceof Error ? e.message : e}`, 'error')
        }
      }

      if (hotApply) {
        const halfFlight = Math.max(60, Math.floor(flightMs / 2))
        await sleepAbortable(halfFlight, abort.signal)
        applyPacket()
        await sleepAbortable(Math.max(0, flightMs - halfFlight), abort.signal)
      } else {
        await sleepAbortable(flightMs, abort.signal)
        presence.setPhase(agent, 'working')
        await sleepAbortable(CURSOR_WORK_MS, abort.signal)
        applyPacket()
      }

      presence.setPhase(agent, 'settling')
      presence.setNote(agent, null)
      await sleepAbortable(CURSOR_SETTLE_MS, abort.signal)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        logger(agent, `cancelled ${packet.command}`, 'info')
        continue
      }
      throw e
    } finally {
      inFlight.delete(flightKey)
    }
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
  inFlight.clear()
  for (const t of lingerTimers.values()) clearTimeout(t)
  lingerTimers.clear()
}
