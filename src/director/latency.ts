/**
 * Utterance→first-motion telemetry — dev-visible timing so streaming/latency
 * work (parse vs theater pacing) can be measured instead of eyeballed.
 */

const MAX_TRACKED_COMMANDS = 24

interface CommandTiming {
  sentAt: number
  firstPacketLoggedAt?: number
  firstApplyLoggedAt?: number
}

const timings = new Map<string, CommandTiming>()

function evictIfFull(): void {
  if (timings.size <= MAX_TRACKED_COMMANDS) return
  const oldest = timings.keys().next().value
  if (oldest) timings.delete(oldest)
}

/** Call the moment a command is sent to the server. */
export function markCommandSent(commandId: string): void {
  timings.set(commandId, { sentAt: performance.now() })
  evictIfFull()
}

/** Returns the elapsed seconds since send on first call for this commandId,
 *  then null on every subsequent call (so callers log exactly once). */
export function markFirstPacket(commandId: string | null | undefined): number | null {
  if (!commandId) return null
  const timing = timings.get(commandId)
  if (!timing || timing.firstPacketLoggedAt !== undefined) return null
  timing.firstPacketLoggedAt = performance.now()
  return (timing.firstPacketLoggedAt - timing.sentAt) / 1000
}

/** Returns elapsed seconds since send on first apply for this commandId, then
 *  null on every subsequent call. Distinguishes theater pacing from parse latency. */
export function markFirstApply(commandId: string | null | undefined): number | null {
  if (!commandId) return null
  const timing = timings.get(commandId)
  if (!timing || timing.firstApplyLoggedAt !== undefined) return null
  timing.firstApplyLoggedAt = performance.now()
  return (timing.firstApplyLoggedAt - timing.sentAt) / 1000
}

/** Test helper — reset module state between unit checks. */
export function resetLatencyForTests(): void {
  timings.clear()
}
