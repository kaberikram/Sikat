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
 */
import { applyCommandPacket } from './command-applier'
import { packetTargetPosition } from './cursor-targets'
import {
  presenceStore,
  CURSOR_FLIGHT_MS,
  CURSOR_WORK_MS,
  CURSOR_SETTLE_MS,
} from './presence'
import type { CommandPacket } from './protocol'

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
export function markAgentActive(agent: string): void {
  presenceStore.getState().setActive(agent, true)
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

    presence.flyTo(agent, packetTargetPosition(packet), 'flying')
    await sleep(CURSOR_FLIGHT_MS)

    presence.setPhase(agent, 'working')
    await sleep(CURSOR_WORK_MS)

    try {
      const result = applyCommandPacket(packet)
      logger(agent, `${packet.command}: ${result}`, 'info')
    } catch (e) {
      logger(agent, `${packet.command} failed: ${e instanceof Error ? e.message : e}`, 'error')
    }

    presence.setPhase(agent, 'settling')
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
