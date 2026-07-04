/**
 * Per-agent execution queue — turns the server's packet stream into paced,
 * watchable work.
 *
 * Instead of applying an `agent_command` the instant it arrives, each agent
 * gets a FIFO queue drained by one async worker. For every packet the worker:
 *   1. points the cursor at the packet's 3D target and glides there (flight),
 *   2. hovers on the target (work),
 *   3. commits the change to the editor store,
 *   4. lingers (settle) before the next task.
 *
 * The cursor is therefore always on the target when the change pops, so the
 * user watches the scene being built rather than getting it all at once. The
 * scene reads the same presence state + timing constants to render the glide,
 * which keeps arrival and apply in agreement.
 *
 * Two behaviours make the crew feel live rather than scripted:
 *   - ANIMATE_OBJECT is special-cased: instead of committing every keyframe in
 *     one pop, the cursor traces the animation path through 3D space keyframe by
 *     keyframe (drawing e.g. a bounce arc), then plays it back on a loop.
 *   - Flight time is proportional to distance, so a nudge on the object the
 *     cursor already hovers is a quick hop, not a full cross-stage glide.
 */
import { applyCommandPacket, presetKeyframes, resolveTarget } from './command-applier'
import { packetTargetPosition } from './cursor-targets'
import {
  presenceStore,
  stationFor,
  CURSOR_FLIGHT_MS,
  CURSOR_WORK_MS,
  CURSOR_SETTLE_MS,
} from './presence'
import { useEditorStore } from '../store'
import type { AnimateObjectPayload, CommandPacket, Vec3 } from './protocol'

type LogLevel = 'info' | 'warn' | 'error'
type Logger = (agent: string, text: string, level: LogLevel) => void

let logger: Logger = () => {}

/** DirectorPod wires this to its log panel; reset to a no-op on unmount. */
export function setRuntimeLogger(fn: Logger): void {
  logger = fn
}

const queues = new Map<string, CommandPacket[]>()
const running = new Set<string>()
/** Agents the server has finished sending work for; their cursor fades once the
 *  local queue drains. */
const pendingIdle = new Set<string>()

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/** Distance→duration for a flight: a nudge on the current target is ~180 ms,
 *  a full cross-stage glide caps at CURSOR_FLIGHT_MS. Reads the cursor's
 *  current presence target so a follow-up on the hovered object hops instantly. */
const MS_PER_UNIT = 95
function flightDurationTo(agent: string, target: Vec3): number {
  const current = presenceStore.getState().agents[agent]?.target ?? stationFor(agent)
  return clamp(dist(current, target) * MS_PER_UNIT, 180, CURSOR_FLIGHT_MS)
}

/** Short present-tense note shown on the cursor while a packet is applied. */
function noteForPacket(packet: CommandPacket): string {
  switch (packet.command) {
    case 'SPAWN_OBJECT':
      return `spawning ${packet.payload.primitive}`
    case 'REMOVE_OBJECT':
      return 'removing'
    case 'TRANSFORM_OBJECT':
      return 'moving'
    case 'ANIMATE_OBJECT':
      return `tracing ${packet.payload.preset}`
    case 'MOVE_CAMERA':
      return 'framing shot'
    case 'UPDATE_LIGHTS':
      return 'lighting'
    case 'SET_MATERIAL':
      return 'painting'
    case 'UPDATE_FX':
      return `${packet.payload.section} fx`
    case 'SET_KEYFRAMES':
      return 'keyframing'
    case 'PLAYBACK':
      return 'cueing'
    default:
      return 'working'
  }
}

// Path-tracing choreography timings. Total time is spread across all keyframes,
// clamped so a coarse track (few keyframes) still feels deliberate and a fine
// one (many) doesn't crawl.
const TRACE_TOTAL_MS = 3000
const TRACE_HOP_MIN = 60
const TRACE_HOP_MAX = 160
const TRACE_CIRCLE_RADIUS = 1.2 // for spin presets with no spatial path

/** Draw a rotation preset's "path" as a circle around the object, so the cursor
 *  has something to trace while it commits rotation keyframes. */
function circlePoint(center: Vec3, i: number, count: number): Vec3 {
  const theta = count > 1 ? (i / (count - 1)) * Math.PI * 2 : 0
  return [
    center[0] + TRACE_CIRCLE_RADIUS * Math.sin(theta),
    center[1],
    center[2] + TRACE_CIRCLE_RADIUS * Math.cos(theta),
  ]
}

/** Trace an animation preset keyframe by keyframe, then loop the result. */
async function traceAnimate(
  agent: string,
  payload: AnimateObjectPayload
): Promise<void> {
  const st = useEditorStore.getState()
  const presence = presenceStore.getState()
  const obj = resolveTarget(payload.target)
  if (!obj) {
    logger(
      agent,
      `ANIMATE_OBJECT failed: target not found: ${payload.target.name ?? payload.target.id}`,
      'error'
    )
    return
  }

  const duration = payload.durationSec ?? st.duration
  const { property, keyframes } = presetKeyframes(obj, payload.preset, duration)
  const count = keyframes.length

  // Pause and wipe the track so the cursor can redraw it live.
  if (st.isPlaying) st.togglePlay()
  st.setObjectPropertyKeyframes(obj.id, property, [])

  const hopMs = clamp(TRACE_TOTAL_MS / count, TRACE_HOP_MIN, TRACE_HOP_MAX)
  const spatial = property === 'position'
  const center = obj.position

  for (let i = 0; i < count; i++) {
    const kf = keyframes[i]
    const point: Vec3 = spatial ? kf.value : circlePoint(center, i, count)
    presence.flyTo(agent, point, 'tracing', hopMs)
    presence.setNote(agent, `tracing ${payload.preset} ${i + 1}/${count}`)
    await sleep(hopMs)
    useEditorStore.getState().addKeyframe(obj.id, kf.time, property, kf.value)
  }

  // Rewind + play so the finished track loops (currentTime % duration).
  useEditorStore.getState().setTime(0)
  if (!useEditorStore.getState().isPlaying) useEditorStore.getState().togglePlay()
  logger(
    agent,
    `ANIMATE_OBJECT: traced ${payload.preset} (${count} keyframes) on ${obj.name}`,
    'info'
  )
}

/** Queue a packet for its target agent and make sure a worker is draining it. */
export function enqueuePacket(packet: CommandPacket): void {
  const agent = packet.target_agent
  pendingIdle.delete(agent) // fresh work cancels any pending fade-out
  const queue = queues.get(agent) ?? []
  queue.push(packet)
  queues.set(agent, queue)
  presenceStore.getState().setActive(agent, true)
  if (!running.has(agent)) void runAgent(agent)
}

/** Server `agent_status` handlers. `active` shows the cursor; `idle` defers the
 *  fade-out to whenever the (slower, choreographed) local queue empties. */
export function markAgentActive(agent: string, note?: string | null): void {
  const presence = presenceStore.getState()
  presence.setActive(agent, true)
  // Show the server's verb immediately to fill parse latency — the worker
  // refines this per packet as it starts each task.
  if (note != null) presence.setNote(agent, note)
}

export function markAgentIdle(agent: string): void {
  const queued = queues.get(agent)?.length ?? 0
  if (!running.has(agent) && queued === 0) {
    presenceStore.getState().setActive(agent, false)
  } else {
    pendingIdle.add(agent)
  }
}

async function runAgent(agent: string): Promise<void> {
  running.add(agent)
  const presence = presenceStore.getState()
  const queue = queues.get(agent)!

  while (queue.length > 0) {
    const packet = queue.shift()!
    presence.setNote(agent, noteForPacket(packet))

    if (packet.command === 'ANIMATE_OBJECT') {
      await traceAnimate(agent, packet.payload)
    } else {
      const target = packetTargetPosition(packet)
      const flightMs = flightDurationTo(agent, target)
      presence.flyTo(agent, target, 'flying', flightMs)
      await sleep(flightMs)

      presence.setPhase(agent, 'working')
      await sleep(CURSOR_WORK_MS)

      try {
        const result = applyCommandPacket(packet)
        logger(agent, `${packet.command}: ${result}`, 'info')
      } catch (e) {
        logger(agent, `${packet.command} failed: ${e instanceof Error ? e.message : e}`, 'error')
      }
    }

    presence.setPhase(agent, 'settling')
    presence.setNote(agent, null)
    await sleep(CURSOR_SETTLE_MS)
  }

  running.delete(agent)
  presence.setPhase(agent, 'idle')
  if (pendingIdle.has(agent)) {
    pendingIdle.delete(agent)
    presence.setActive(agent, false)
  }
}

/** Test/hot-reload hook: drop all queued work and presence-fade every agent. */
export function resetAgentRuntime(): void {
  queues.clear()
  running.clear()
  pendingIdle.clear()
}
