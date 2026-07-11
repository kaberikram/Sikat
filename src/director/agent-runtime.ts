/**
 * Per-agent execution queue — turns the server's packet stream into paced work.
 *
 * Cursors fly to the target, the change commits, then the cursor **follows**
 * the affected object while it animates (main + viewfinder show the real motion).
 * No fake path-tracing or trail drawing.
 */
import { applyCommandPacket, cancelCommandPacket, resolveTarget } from './command-applier'
import { liveTargetPosition, packetTargetPosition } from './cursor-targets'
import { markFirstApply, markFirstCursorMove, markFirstPreview, markFirstRefinement } from './latency'
import {
  presenceStore,
  stationFor,
  cursorVisible,
  pendingAnchorPosition,
  CURSOR_ANNOUNCE_MS,
  CURSOR_FLIGHT_MS,
  CURSOR_INTENT_MS,
  CURSOR_WORK_MS,
  CURSOR_SETTLE_MS,
  CURSOR_MOTION_FADE_MS,
  CURSOR_FADE_MS,
  PENDING_SHOW_DELAY_MS,
  PENDING_RESPONSE_TIMEOUT_MS,
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

type SteeringConfidence = IntentPreviewConfidence

const CONFIDENCE_RANK: Record<SteeringConfidence, number> = {
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
const fadeTimers = new Map<string, ReturnType<typeof setTimeout>>()
const suggestionGlance = new Set<string>()
const commandSteering = new Map<string, CommandSteering>()
const lastAgentByCommand = new Map<string, string>()
const responseTimers = new Map<string, ReturnType<typeof setTimeout>>()
const pendingShowTimers = new Map<string, ReturnType<typeof setTimeout>>()
const pendingTimeoutHandlers = new Map<string, (() => void) | undefined>()
/** Anchor captured at submit — used if the named agent appears before pending shows. */
const pendingAnchors = new Map<string, ReturnType<typeof pendingAnchorPosition>>()

function clearFadeTimer(agent: string): void {
  const t = fadeTimers.get(agent)
  if (t) clearTimeout(t)
  fadeTimers.delete(agent)
}

function clearPendingShowTimer(commandId: string): void {
  const timer = pendingShowTimers.get(commandId)
  if (timer) clearTimeout(timer)
  pendingShowTimers.delete(commandId)
}

function clearResponseTimer(commandId: string): void {
  const timer = responseTimers.get(commandId)
  if (timer) clearTimeout(timer)
  responseTimers.delete(commandId)
  pendingTimeoutHandlers.delete(commandId)
  clearPendingShowTimer(commandId)
}

function clearResponseTimersForAgent(agent: string): void {
  for (const [commandId, steering] of commandSteering) {
    if (steering.agent === agent) clearResponseTimer(commandId)
  }
}

function resolvePending(commandId: string | null | undefined, agent: string): void {
  if (!commandId) return
  clearResponseTimer(commandId)
  const presence = presenceStore.getState()
  const pos =
    presence.pendingPosition(commandId) ??
    pendingAnchors.get(commandId) ??
    pendingAnchorPosition()
  pendingAnchors.delete(commandId)
  presence.appearAt(agent, pos)
  presence.clearPending(commandId)
}

/** Arm pending tracking. The anonymous cursor only appears after a short delay
 *  so fast chitchat / describe-only replies never flash a stage cursor. */
export function beginPendingCommand(
  commandId: string,
  opts?: { onTimeout?: () => void }
): void {
  clearResponseTimer(commandId)
  const anchor = pendingAnchorPosition()
  pendingAnchors.set(commandId, anchor)
  pendingTimeoutHandlers.set(commandId, opts?.onTimeout)

  pendingShowTimers.set(
    commandId,
    setTimeout(() => {
      pendingShowTimers.delete(commandId)
      if (!pendingAnchors.has(commandId)) return
      presenceStore.getState().showPending(commandId, anchor)
    }, PENDING_SHOW_DELAY_MS)
  )

  responseTimers.set(
    commandId,
    setTimeout(() => {
      responseTimers.delete(commandId)
      const onTimeout = pendingTimeoutHandlers.get(commandId)
      pendingTimeoutHandlers.delete(commandId)
      clearPendingShowTimer(commandId)
      pendingAnchors.delete(commandId)
      presenceStore.getState().clearPending(commandId)
      logger('SYSTEM', 'no response — check the Director server', 'warn')
      onTimeout?.()
    }, PENDING_RESPONSE_TIMEOUT_MS)
  )
}

/** Drop pending cursor / timers without touching a named agent's choreography. */
export function clearPendingCommand(commandId: string): void {
  clearResponseTimer(commandId)
  pendingAnchors.delete(commandId)
  presenceStore.getState().clearPending(commandId)
}

const sleepAbortable = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
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
    case 'CALL_STORE_ACTION':
      return `store: ${packet.payload.action}`
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

  if (!commandId) {
    presence.setNote(agent, note, true)
    presence.flyTo(agent, target, 'intent', CURSOR_INTENT_MS)
    return
  }

  const rank = steeringRank(conf)
  const existing = commandSteering.get(commandId)

  if (existing) {
    if (rank < existing.confidenceRank) {
      return
    }
    if (rank === existing.confidenceRank && agent === existing.agent) {
      presence.setNote(agent, note, true)
      return
    }
    if (existing.agent !== agent) {
      markAgentIdle(existing.agent)
    }
  }

  resolvePending(commandId, agent)
  commandSteering.set(commandId, { agent, confidenceRank: rank })
  lastAgentByCommand.set(commandId, agent)
  presence.setNote(agent, note, true)
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
  resolvePending(commandId, agent)
  commandSteering.set(commandId, { agent, confidenceRank: PACKET_CONFIDENCE_RANK })
  lastAgentByCommand.set(commandId, agent)
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

  releaseCommandPresence(msg.commandId)
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
  clearFadeTimer(agent)
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

export function markAgentActive(agent: string, note?: string | null, commandId?: string | null): void {
  if (!cursorVisible(agent)) return
  if (commandId) resolvePending(commandId, agent)
  const presence = presenceStore.getState()
  presence.setActive(agent, true)
  clearResponseTimersForAgent(agent)
  presence.setPhase(agent, 'intent')
  if (note != null) presence.setNote(agent, note, true)
}

/** Authoritative server preview — names the agent and flies from the pending spot. */
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

/** Clear pending cursor + steered agent for a command (cancel / error / send fail). */
export function releaseCommandPresence(commandId: string): void {
  clearPendingCommand(commandId)
  const agent = lastAgentByCommand.get(commandId)
  if (agent) markAgentIdle(agent)
  lastAgentByCommand.delete(commandId)
  commandSteering.delete(commandId)
}

export function markAgentIdle(agent: string): void {
  if (!cursorVisible(agent)) return
  if (suggestionGlance.has(agent)) return
  clearResponseTimersForAgent(agent)
  const queued = queues.get(agent)?.length ?? 0
  if (running.has(agent) || queued > 0) {
    // Local packet queue still owns flying → work → settle → check.
    pendingIdle.add(agent)
    return
  }
  const phase = presenceStore.getState().agents[agent]?.phase
  // Producer idle must not restart/shorten an in-progress settle or soft exit.
  if (phase === 'settling' || phase === 'done' || fadeTimers.has(agent)) return
  scheduleAgentFadeOut(agent)
}

/** Keep the cursor on stage with a spinner while the command is still open
 *  (grammar finished a batch; LLM motion may still be coming). */
export function markAgentWaiting(agent: string): void {
  if (!cursorVisible(agent)) return
  if (suggestionGlance.has(agent)) return
  clearFadeTimer(agent)
  pendingIdle.delete(agent)
  const presence = presenceStore.getState()
  const prev = presence.agents[agent]
  presence.setActive(agent, true)
  presence.setPhase(agent, 'intent')
  // Clear note so status rules show spinner, not a stale bubble.
  presence.setNote(agent, null)

  // Park on the last touched object (or director anchor) — never leave the
  // cursor stranded at a far crew station while waiting.
  const touchId = prev?.followObjectId ?? prev?.lastTouchedObjectId
  if (touchId) {
    const live = liveTargetPosition({ id: touchId })
    if (live) {
      presence.followObject(agent, touchId)
      presence.flyTo(agent, live, 'intent', CURSOR_INTENT_MS)
      return
    }
  }
  const anchor = pendingAnchorPosition()
  presence.flyTo(agent, anchor, 'intent', CURSOR_INTENT_MS)
}

/** Fade agents left spinning after the command fully completes (Producer idle). */
export function releaseWaitingAgents(): void {
  const agents = presenceStore.getState().agents
  for (const agent of Object.keys(agents)) {
    if (!cursorVisible(agent)) continue
    const p = agents[agent]
    if (!p?.active) continue
    if (p.phase !== 'intent') continue
    if (running.has(agent) || (queues.get(agent)?.length ?? 0) > 0) continue
    scheduleAgentFadeOut(agent)
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
  clearFadeTimer(agent)
  const delayMs = motionWork ? CURSOR_MOTION_FADE_MS : CURSOR_FADE_MS
  fadeTimers.set(
    agent,
    setTimeout(() => {
      presenceStore.getState().fadeOut(agent)
      fadeTimers.delete(agent)
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
  let needsAnnounce = true

  while (queue.length > 0) {
    const packet = queue.shift()!
    const objectId = packetSupersedeTargetId(packet)
    const flightKey = `${packet.commandId ?? 'local'}:${packet.command}:${objectId ?? 'global'}`
    const abort = new AbortController()
    inFlight.set(flightKey, abort)

    const serverNote = presence.agents[agent]?.note
    presence.setNote(agent, serverNote ?? noteForPacket(packet), true)

    try {
      // Hold the named spinner/label before the first travel beat, even when
      // intent_preview and the first packet arrive in the same event turn.
      if (needsAnnounce && presence.agents[agent]?.phase === 'intent') {
        await sleepAbortable(CURSOR_ANNOUNCE_MS, abort.signal)
        needsAnnounce = false
      } else {
        needsAnnounce = false
      }

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
        presence.setNote(agent, null)
        continue
      }
      throw e
    } finally {
      inFlight.delete(flightKey)
    }
  }

  running.delete(agent)
  presence.setPhase(agent, 'done')
  pendingIdle.delete(agent)
  scheduleAgentFadeOut(agent, motionWork)
}

export function resetAgentRuntime(): void {
  queues.clear()
  running.clear()
  pendingIdle.clear()
  inFlight.clear()
  commandSteering.clear()
  lastAgentByCommand.clear()
  for (const t of fadeTimers.values()) clearTimeout(t)
  fadeTimers.clear()
  for (const t of responseTimers.values()) clearTimeout(t)
  responseTimers.clear()
  for (const t of pendingShowTimers.values()) clearTimeout(t)
  pendingShowTimers.clear()
  pendingTimeoutHandlers.clear()
  pendingAnchors.clear()
  presenceStore.setState({ pending: {} })
}
