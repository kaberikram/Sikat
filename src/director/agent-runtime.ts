/**
 * Per-agent execution queue — turns the server's packet stream into paced work.
 *
 * Cursors fly to the target, the change commits, then the cursor **follows**
 * the affected object while it animates (main + viewfinder show the real motion).
 * No fake path-tracing or trail drawing.
 */
import { applyCommandPacket, cancelCommandPacket, resolveTarget } from './command-applier'
import { liveTargetPosition, packetTargetPosition } from './cursor-targets'
import { guessIntent, type IntentGuess } from './intent-guess'
import { markFirstApply, markFirstCursorMove, markFirstPreview, markFirstRefinement } from './latency'
import {
  presenceStore,
  stationFor,
  cursorVisible,
  CURSOR_FLIGHT_MS,
  CURSOR_INTENT_MS,
  CURSOR_WORK_MS,
  CURSOR_SETTLE_MS,
  CURSOR_MOTION_FADE_MS,
  CURSOR_FADE_MS,
} from './presence'
import { useEditorStore } from '../store'
import type {
  CommandPacket,
  CommandCancelMessage,
  IntentPreviewConfidence,
  IntentPreviewMessage,
  AgentSuggestionMessage,
  Target,
  Vec3,
} from './protocol'

type LogLevel = 'info' | 'warn' | 'error'
type Logger = (agent: string, text: string, level: LogLevel) => void

type SteeringConfidence = 'client_guess' | IntentPreviewConfidence

const CONFIDENCE_RANK: Record<SteeringConfidence, number> = {
  client_guess: 0,
  guess: 0,
  grammar: 1,
  llm_partial: 2,
}

const PACKET_CONFIDENCE_RANK = 3
const REFINE_INTENT_MS = 120

interface CommandSteering {
  agent: string
  confidenceRank: number
}

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
const commandSteering = new Map<string, CommandSteering>()
const lastGuessByCommand = new Map<string, string>()

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

function steeringRank(conf: SteeringConfidence): number {
  return CONFIDENCE_RANK[conf]
}

/** Record preview steering; fly only when confidence increases or agent changes. */
function commitSteering(
  commandId: string | null | undefined,
  agent: string,
  conf: SteeringConfidence,
  note: string,
  target: Vec3
): void {
  if (!cursorVisible(agent)) return

  const presence = presenceStore.getState()
  presence.setActive(agent, true)
  presence.setNote(agent, note)

  if (!commandId) {
    presence.flyTo(agent, target, 'intent', CURSOR_INTENT_MS)
    return
  }

  const rank = steeringRank(conf)
  const existing = commandSteering.get(commandId)

  if (existing) {
    if (rank < existing.confidenceRank) {
      if (agent === existing.agent) presence.setNote(agent, note)
      return
    }
    if (rank === existing.confidenceRank && agent === existing.agent) {
      presence.setNote(agent, note)
      return
    }
    if (existing.agent !== agent) {
      markAgentIdle(existing.agent)
    }
  }

  commandSteering.set(commandId, { agent, confidenceRank: rank })
  lastGuessByCommand.set(commandId, agent)
  presence.flyTo(agent, target, 'intent', CURSOR_INTENT_MS)
}

function handoffSteeringToPacket(commandId: string | null | undefined, agent: string): void {
  if (!commandId || !cursorVisible(agent)) return
  const existing = commandSteering.get(commandId)
  if (existing && existing.agent !== agent) {
    const oldQueued = queues.get(existing.agent)?.length ?? 0
    if (!running.has(existing.agent) && oldQueued === 0) {
      markAgentIdle(existing.agent)
    }
  }
  commandSteering.set(commandId, { agent, confidenceRank: PACKET_CONFIDENCE_RANK })
  lastGuessByCommand.set(commandId, agent)
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

  commandSteering.delete(msg.commandId)
  lastGuessByCommand.delete(msg.commandId)
}

export function enqueuePacket(packet: CommandPacket): void {
  const agent = packet.target_agent
  if (!cursorVisible(agent)) {
    const queue = queues.get(agent) ?? []
    queue.push(packet)
    queues.set(agent, queue)
    if (!running.has(agent)) void runAgent(agent)
    return
  }

  handoffSteeringToPacket(packet.commandId ?? null, agent)
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
  if (!cursorVisible(agent)) return
  const presence = presenceStore.getState()
  presence.setActive(agent, true)
  if (note != null) presence.setNote(agent, note)
}

function targetPositionForGuess(guess: IntentGuess): Vec3 {
  if (guess.targetObjectId) {
    const live = liveTargetPosition({ id: guess.targetObjectId })
    if (live) return live
  }
  if (guess.targetName) {
    const live = liveTargetPosition({ name: guess.targetName })
    if (live) return live
  }
  return stationFor(guess.agent)
}

/** Instant client-side reaction before server parse (Phase F1). */
export function applyClientIntentGuess(text: string, commandId?: string | null): string | null {
  const guess = guessIntent(text)
  if (!guess) return null
  markFirstCursorMove(commandId)
  commitSteering(commandId, guess.agent, 'client_guess', guess.note, targetPositionForGuess(guess))
  return guess.agent
}

/** Authoritative server preview — supersedes client guess (Phase F2). */
export function applyIntentPreview(msg: IntentPreviewMessage): void {
  if (!cursorVisible(msg.agent)) return
  markFirstPreview(msg.commandId)
  let target: Vec3 = stationFor(msg.agent)
  if (msg.target) {
    target = liveTargetPosition({ name: msg.target }) ?? target
  }
  markFirstCursorMove(msg.commandId)
  commitSteering(msg.commandId, msg.agent, msg.confidence, msg.note, target)
}

export function idleGuessedAgent(commandId: string): void {
  const agent = lastGuessByCommand.get(commandId)
  if (agent) markAgentIdle(agent)
  lastGuessByCommand.delete(commandId)
  commandSteering.delete(commandId)
}

export function markAgentIdle(agent: string): void {
  if (!cursorVisible(agent)) return
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
  if (!cursorVisible(msg.agent)) return
  const agent = msg.agent
  suggestionGlance.add(agent)
  markAgentActive(agent, msg.text)
  let target: Vec3 = stationFor(agent)
  if (msg.subjectObject) {
    target = liveTargetPosition({ name: msg.subjectObject }) ?? target
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

/** Fade the cursor out after work — no long wander/playback tail. */
function scheduleAgentFadeOut(agent: string, motionWork = false): void {
  if (!cursorVisible(agent)) return
  const presence = presenceStore.getState()
  presence.followObject(agent, null)
  clearLingerTimer(agent)
  const delayMs = motionWork ? CURSOR_MOTION_FADE_MS : CURSOR_FADE_MS
  lingerTimers.set(
    agent,
    setTimeout(() => {
      presenceStore.getState().fadeOut(agent)
      lingerTimers.delete(agent)
    }, delayMs)
  )
}

async function runAgent(agent: string): Promise<void> {
  running.add(agent)
  const queue = queues.get(agent)!

  if (!cursorVisible(agent)) {
    while (queue.length > 0) {
      const packet = queue.shift()!
      try {
        const result = applyCommandPacket(packet)
        logger(agent, `${packet.command}: ${result}`, 'info')
      } catch (e) {
        logger(agent, `${packet.command} failed: ${e instanceof Error ? e.message : e}`, 'error')
      }
    }
    running.delete(agent)
    return
  }

  const presence = presenceStore.getState()
  let motionWork = false

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
        const followId = followObjectIdForPacket(packet)
        if (followId) {
          const refineTarget = packetTargetPosition(packet)
          presence.flyTo(agent, refineTarget, 'intent', REFINE_INTENT_MS)
          await sleepAbortable(REFINE_INTENT_MS, abort.signal)
        }
        try {
          const result = applyCommandPacket(packet)
          logger(agent, `${packet.command} (refine): ${result}`, 'info')
          const refineElapsed = markFirstRefinement(packet.commandId)
          if (refineElapsed != null) logger('SYSTEM', `⏱ first refine ${refineElapsed.toFixed(2)}s`, 'info')
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
      const motionPacket =
        packet.command === 'ANIMATE_OBJECT' || packet.command === 'TRANSFORM_OBJECT'
      if (motionPacket) motionWork = true

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

      if (motionPacket) {
        await sleepAbortable(flightMs, abort.signal)
        applyPacket()
        presence.followObject(agent, null)
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
  pendingIdle.delete(agent)
  scheduleAgentFadeOut(agent, motionWork)
}

export function resetAgentRuntime(): void {
  queues.clear()
  running.clear()
  pendingIdle.clear()
  inFlight.clear()
  commandSteering.clear()
  lastGuessByCommand.clear()
  for (const t of lingerTimers.values()) clearTimeout(t)
  lingerTimers.clear()
}
