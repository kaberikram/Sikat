/**
 * Per-agent execution queue — turns the server's packet stream into paced work.
 *
 * Cursors fly to the target, the change commits, then the cursor **follows**
 * the affected object while it animates (main + viewfinder show the real motion).
 * No fake path-tracing or trail drawing.
 */
import { applyCommandPacket, cancelCommandPacket, resolveTarget } from './command-applier'
import { classifyCursorHome, idleDecision, watchdogExpired } from './cursor-lifecycle'
import { clearGhost, showGhost } from './ghost-preview'
import { clearProposal, showProposal } from './proposal-ghost'
import { respond } from '../scene/xr/ambient-channel'
import { liveTargetPosition, packetTargetPosition } from './cursor-targets'
import { markFirstApply, markFirstCursorMove, markFirstPreview, markFirstRefinement } from './latency'
import { crewWhoosh } from './sound'
import {
  presenceStore,
  agentMetaFor,
  stationFor,
  cursorVisible,
  CURSOR_ANNOUNCE_MS,
  CURSOR_FLIGHT_MS,
  CURSOR_INTENT_MS,
  CURSOR_WORK_MS,
  CURSOR_SETTLE_MS,
  CURSOR_MOTION_FADE_MS,
  CURSOR_FADE_MS,
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
const commandSteering = new Map<string, CommandSteering>()
const lastAgentByCommand = new Map<string, string>()
const responseTimers = new Map<string, ReturnType<typeof setTimeout>>()
const pendingTimeoutHandlers = new Map<string, (() => void) | undefined>()
/**
 * `performance.now()` of each visible cursor's last real work beat. The
 * watchdog reads this; nothing else may make a cursor visible without writing
 * it, which is what makes a stuck cursor structurally impossible rather than
 * something every exit path has to remember to prevent.
 */
const lastWorkBeat = new Map<string, number>()

function clearFadeTimer(agent: string): void {
  const t = fadeTimers.get(agent)
  if (t) clearTimeout(t)
  fadeTimers.delete(agent)
}

/**
 * Record that this agent did something real. Every path that keeps a cursor on
 * stage must call this — the watchdog treats silence as a stuck cursor.
 */
function noteWorkBeat(agent: string): void {
  lastWorkBeat.set(agent, performance.now())
}

/**
 * The backstop. Any cursor that hasn't had a work beat inside the budget is
 * retired, whatever any other path believes about who owns its choreography.
 *
 * The bug this exists to make impossible: a drain that dies mid-flight (throw,
 * cancel, dropped socket, session end) leaves the cursor lit and nothing ever
 * schedules its fade. Rather than patching each of those paths and hoping the
 * list is complete, one sweep collects them all.
 */
function sweepStuckCursors(): void {
  if (lastWorkBeat.size === 0) return
  const now = performance.now()
  const agents = presenceStore.getState().agents
  for (const [agent, beat] of [...lastWorkBeat]) {
    if (!agents[agent]?.active) {
      lastWorkBeat.delete(agent)
      continue
    }
    if (running.has(agent) || (queues.get(agent)?.length ?? 0) > 0) continue
    if (!watchdogExpired(beat, now)) continue
    logger(agent, 'cursor retired (no work beat)', 'warn')
    lastWorkBeat.delete(agent)
    clearFadeTimer(agent)
    presenceStore.getState().fadeOut(agent)
  }
}

let watchdogInterval: ReturnType<typeof setInterval> | null = null

function ensureWatchdog(): void {
  if (watchdogInterval !== null || typeof setInterval === 'undefined') return
  // Coarse on purpose — this is a safety net, not an animation.
  watchdogInterval = setInterval(sweepStuckCursors, 2000)
}

/**
 * Drop every cursor and every timer. Called on XR session end, rig dispose,
 * socket close, and scene teardown — the four places a choreography can be
 * abandoned mid-flight.
 */
export function retireAllCursors(): void {
  for (const t of fadeTimers.values()) clearTimeout(t)
  fadeTimers.clear()
  for (const t of responseTimers.values()) clearTimeout(t)
  responseTimers.clear()
  pendingTimeoutHandlers.clear()
  lastWorkBeat.clear()
  commandSteering.clear()
  lastAgentByCommand.clear()
  pendingIdle.clear()
  for (const abort of inFlight.values()) abort.abort()
  inFlight.clear()
  const presence = presenceStore.getState()
  for (const agent of Object.keys(presence.agents)) presence.fadeOut(agent)
  if (watchdogInterval !== null) {
    clearInterval(watchdogInterval)
    watchdogInterval = null
  }
}

function clearResponseTimer(commandId: string): void {
  const timer = responseTimers.get(commandId)
  if (timer) clearTimeout(timer)
  responseTimers.delete(commandId)
  pendingTimeoutHandlers.delete(commandId)
}

function clearResponseTimersForAgent(agent: string): void {
  for (const [commandId, steering] of commandSteering) {
    if (steering.agent === agent) clearResponseTimer(commandId)
  }
}

/**
 * The server named an agent for this command. That is not work yet, so it no
 * longer draws anything — it only closes the no-response watch. A cursor turns
 * on in exactly one place: `enqueuePacket`, once a packet with a real home
 * exists.
 */
function resolvePending(commandId: string | null | undefined, _agent: string): void {
  if (!commandId) return
  clearResponseTimer(commandId)
}

/**
 * Arm the no-response watch for a submitted command.
 *
 * This used to also schedule an anonymous cursor to fade in above the middle of
 * the set after a short delay, on the theory that it made the set feel
 * responsive during the round-trip. It pointed at nothing, and when the command
 * turned out to be chitchat or a failure it had already flown in for no reason.
 * The round-trip is now carried by the room's travelling arc, which is honest
 * about being a state rather than a place.
 */
export function beginPendingCommand(
  commandId: string,
  opts?: { onTimeout?: () => void }
): void {
  clearResponseTimer(commandId)
  pendingTimeoutHandlers.set(commandId, opts?.onTimeout)

  responseTimers.set(
    commandId,
    setTimeout(() => {
      responseTimers.delete(commandId)
      const onTimeout = pendingTimeoutHandlers.get(commandId)
      pendingTimeoutHandlers.delete(commandId)
          logger('SYSTEM', 'no response — check the Director server', 'warn')
      onTimeout?.()
    }, PENDING_RESPONSE_TIMEOUT_MS)
  )
}

/** Drop a command's timers without touching a named agent's choreography. */
export function clearPendingCommand(commandId: string): void {
  clearResponseTimer(commandId)
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
  // An intent preview is a guess about a command still being parsed. It records
  // who is likely to act and steers a cursor that is *already* on stage, but it
  // never summons one — what the system understood is shown by the ghost
  // preview, which can be wrong without a crew member appearing to own it.
  const onStage = Boolean(presence.agents[agent]?.active)

  if (!commandId) {
    presence.setNote(agent, note, true)
    if (onStage) presence.flyTo(agent, target, 'intent', CURSOR_INTENT_MS)
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
  if (onStage) presence.flyTo(agent, target, 'intent', CURSOR_INTENT_MS)
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

/**
 * The target a packet's cursor should resolve against. Mirrors the subjects
 * `packetTargetPosition` understands, but returns the Target rather than a
 * position so the caller can tell "unresolved" from "scene-global".
 */
function packetSubjectTarget(packet: CommandPacket): Target | null {
  switch (packet.command) {
    case 'REMOVE_OBJECT':
    case 'TRANSFORM_OBJECT':
    case 'ANIMATE_OBJECT':
    case 'SET_MATERIAL':
      return packet.payload.target
    case 'SET_KEYFRAMES':
      return packet.payload.target ?? null
    default:
      return null
  }
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
    if (!running.has(agent)) {
    void runAgent(agent).catch((e) => {
      logger(agent, `agent runner crashed: ${e instanceof Error ? e.message : e}`, 'error')
    })
  }
    return
  }

  handoffSteeringToPacket(packet.commandId ?? null, agent)
  clearFadeTimer(agent)
  const presence = presenceStore.getState()
  pendingIdle.delete(agent)

  // The single place a cursor turns on. A packet is about to change something,
  // so there is finally a real claim to make and a real place to make it from.
  if (!presence.agents[agent]?.active) {
    const subject = packetSubjectTarget(packet)
    const home = classifyCursorHome(subject ? liveTargetPosition(subject) : null, subject !== null)
    if (home.kind === 'none') {
      // The packet named a subject and it didn't resolve. There is nowhere
      // honest to stand — the packet still applies, it just does so
      // unattributed rather than sending a cursor somewhere unrelated.
      logger(agent, `${packet.command}: no cursor (unresolved target)`, 'info')
    } else {
      // Scene-wide work uses packetTargetPosition, which knows the truthful
      // spot per command (the spawn point, the camera, the station).
      const at = home.kind === 'object' ? home.position : packetTargetPosition(packet)
      // Settle in place at the thing it's about to touch rather than swooping
      // across the room from a station nobody was looking at. Flights are for
      // subsequent moves, where they read as choreography instead of a glitch.
      presence.appearAt(agent, at)
      noteWorkBeat(agent)
      ensureWatchdog()
      crewWhoosh(at[0])
    }
  } else {
    noteWorkBeat(agent)
  }

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
  if (!running.has(agent)) {
    void runAgent(agent).catch((e) => {
      logger(agent, `agent runner crashed: ${e instanceof Error ? e.message : e}`, 'error')
    })
  }
}

/**
 * The server says this agent picked up the command ("copy", "on it"). That is a
 * status line, not work — it no longer turns a cursor on. If the agent already
 * has one, the note updates it; otherwise this is silent and the cursor arrives
 * with the first packet.
 */
export function markAgentActive(agent: string, note?: string | null, commandId?: string | null): void {
  if (!cursorVisible(agent)) return
  if (commandId) resolvePending(commandId, agent)
  const presence = presenceStore.getState()
  clearResponseTimersForAgent(agent)
  if (!presence.agents[agent]?.active) return
  noteWorkBeat(agent)
  presence.setPhase(agent, 'intent')
  if (note != null) presence.setNote(agent, note, true)
}

/** Authoritative server preview — names the agent and flies from the pending spot. */
export function applyIntentPreview(msg: IntentPreviewMessage): void {
  // Ghost of the understood outcome — shown even for Producer-attributed
  // previews (the ghost is about the scene, not the cursor).
  showGhost(msg)
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
  clearGhost(commandId)
  clearPendingCommand(commandId)
  const agent = lastAgentByCommand.get(commandId)
  if (agent) markAgentIdle(agent)
  lastAgentByCommand.delete(commandId)
  commandSteering.delete(commandId)
}

export function markAgentIdle(agent: string): void {
  if (!cursorVisible(agent)) return
  clearResponseTimersForAgent(agent)
  const queued = queues.get(agent)?.length ?? 0
  const decision = idleDecision({
    phase: presenceStore.getState().agents[agent]?.phase,
    busy: running.has(agent) || queued > 0,
    hasFadeTimer: fadeTimers.has(agent),
  })
  if (decision === 'already-scheduled') return
  if (decision === 'defer') {
    // The drain owns flying → work → settle → check, and Producer idle must not
    // shorten an in-progress settle. But the fade is now *owed*: pendingIdle
    // records that, and the watchdog collects if the drain never finishes.
    pendingIdle.add(agent)
    return
  }
  scheduleAgentFadeOut(agent)
}

/**
 * Keep an already-visible cursor on stage with a spinner while the command is
 * still open (grammar finished a batch; LLM motion may still be coming).
 *
 * Keep-alive only. This used to call `setActive(agent, true)` and could
 * therefore summon a cursor to spin over nothing at all — and when there was no
 * object to park on it fell back to an anchor floating above the middle of the
 * set. If no cursor is up, waiting is silent and the cursor arrives with the
 * first packet.
 */
export function markAgentWaiting(agent: string): void {
  if (!cursorVisible(agent)) return
  const presence = presenceStore.getState()
  const prev = presence.agents[agent]
  if (!prev?.active) return

  clearFadeTimer(agent)
  pendingIdle.delete(agent)
  noteWorkBeat(agent)
  presence.setPhase(agent, 'intent')
  // Clear note so status rules show spinner, not a stale bubble.
  presence.setNote(agent, null)

  // Park on the last touched object so the cursor isn't stranded at a far crew
  // station while waiting. With no object to park on it simply holds position —
  // staying put is honest, and better than drifting somewhere meaningless.
  const touchId = prev.followObjectId ?? prev.lastTouchedObjectId
  if (!touchId) return
  const live = liveTargetPosition({ id: touchId })
  if (!live) return
  presence.followObject(agent, touchId)
  presence.flyTo(agent, live, 'intent', CURSOR_INTENT_MS)
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

/** Latest actionable crew suggestion — surfaced on the XR slate; "do it" accepts. */
const SUGGESTION_FRESH_MS = 25_000
let latestSuggestion: { msg: AgentSuggestionMessage; at: number } | null = null

export function getLatestSuggestion(): AgentSuggestionMessage | null {
  if (!latestSuggestion) return null
  if (Date.now() - latestSuggestion.at > SUGGESTION_FRESH_MS) {
    latestSuggestion = null
    return null
  }
  return latestSuggestion.msg
}

/** Returns and clears the fresh suggestion (accept path). */
export function consumeLatestSuggestion(): AgentSuggestionMessage | null {
  const msg = getLatestSuggestion()
  latestSuggestion = null
  // Taken up — drop the offer's ghost so the real change isn't racing its own
  // silhouette.
  clearProposal()
  return msg
}

/**
 * Proactive crew suggestion.
 *
 * This used to fly a cursor over for a three-second "glance" — a crew member
 * appearing on stage to point at something they had merely *thought about*.
 * Suggesting is not work, and the glance also carried its own retirement timer
 * that could race the real one and strand the cursor.
 *
 * Attribution for an offer is now the proposal ghost standing on the set plus
 * the room briefly wearing the proposing member's colour, neither of which
 * claims anyone is doing anything.
 */
export function reactToSuggestion(msg: AgentSuggestionMessage): void {
  if (msg.kind === 'suggestion' && msg.suggestedCommand) {
    latestSuggestion = { msg, at: Date.now() }
    // In the headset the offer stands on the set as a breathing ghost of what
    // it would do. Never auto-applied: a proposal is a ghost until a voice
    // takes it up, which is what keeps proactive help reversible by default.
    if (useEditorStore.getState().xrActive) {
      const outcome = showProposal(msg)
      // A bad moment stays silent entirely — the offer is still live for 25s,
      // so "do it" picks it up whenever the director comes up for air.
      if (outcome !== 'bad-moment') {
        respond({
          kind: 'proposed',
          text: msg.text,
          color: agentMetaFor(msg.agent).color,
          spatial: outcome === 'shown',
        })
      }
    }
  }
  if (!cursorVisible(msg.agent)) return
  // Remember the subject so that if this offer *is* taken up, the resulting
  // packets already know which object this member was talking about.
  if (msg.subjectObject) {
    const id = resolveTarget({ name: msg.subjectObject })?.id
    if (id) presenceStore.getState().touchLastObject(msg.agent, id)
  }
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
  // A throw escaping this loop would skip running.delete(agent) and wedge the
  // agent's queue forever (runAgent is launched fire-and-forget) — every later
  // packet would silently queue behind a drain that never restarts.
  try {
    await drainAgentQueue(agent)
  } finally {
    running.delete(agent)
  }
}

async function drainAgentQueue(agent: string): Promise<void> {
  const queue = queues.get(agent)!

  if (!cursorVisible(agent)) {
    while (queue.length > 0) {
      const packet = queue.shift()!
      try {
        clearGhost(packet.commandId)
        const result = applyCommandPacket(packet)
        logger(agent, `${packet.command}: ${result}`, 'info')
      } catch (e) {
        logger(agent, `${packet.command} failed: ${e instanceof Error ? e.message : e}`, 'error')
      }
    }
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
          clearGhost(packet.commandId)
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
          clearGhost(packet.commandId)
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
      // One bad packet must not kill the drain loop (or wedge the queue).
      logger(agent, `unexpected error in ${packet.command}: ${e instanceof Error ? e.message : e}`, 'error')
      continue
    } finally {
      inFlight.delete(flightKey)
    }
  }

  presence.setPhase(agent, 'done')
  pendingIdle.delete(agent)
  scheduleAgentFadeOut(agent, motionWork)
}

export function resetAgentRuntime(): void {
  queues.clear()
  running.clear()
  retireAllCursors()
}
