/**
 * Utterance→first-motion telemetry — dev-visible timing so streaming/latency
 * work (parse vs theater pacing) can be measured instead of eyeballed.
 */

const MAX_TRACKED_COMMANDS = 24

interface CommandTiming {
  sentAt: number
  firstPreviewLoggedAt?: number
  firstCursorMoveLoggedAt?: number
  firstPacketLoggedAt?: number
  firstApplyLoggedAt?: number
  firstRefinementLoggedAt?: number
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

function markOnce(
  commandId: string | null | undefined,
  field: keyof Pick<
    CommandTiming,
    'firstPreviewLoggedAt' | 'firstCursorMoveLoggedAt' | 'firstPacketLoggedAt' | 'firstApplyLoggedAt' | 'firstRefinementLoggedAt'
  >
): number | null {
  if (!commandId) return null
  const timing = timings.get(commandId)
  if (!timing || timing[field] !== undefined) return null
  const now = performance.now()
  timing[field] = now
  return (now - timing.sentAt) / 1000
}

/** Returns elapsed seconds since send on first preview, then null. */
export function markFirstPreview(commandId: string | null | undefined): number | null {
  return markOnce(commandId, 'firstPreviewLoggedAt')
}

/** Returns elapsed seconds since send on first cursor move, then null. */
export function markFirstCursorMove(commandId: string | null | undefined): number | null {
  return markOnce(commandId, 'firstCursorMoveLoggedAt')
}

/** Returns the elapsed seconds since send on first call for this commandId,
 *  then null on every subsequent call (so callers log exactly once). */
export function markFirstPacket(commandId: string | null | undefined): number | null {
  return markOnce(commandId, 'firstPacketLoggedAt')
}

/** Returns elapsed seconds since send on first apply for this commandId, then
 *  null on every subsequent call. Distinguishes theater pacing from parse latency. */
export function markFirstApply(commandId: string | null | undefined): number | null {
  return markOnce(commandId, 'firstApplyLoggedAt')
}

/** Returns elapsed seconds since send on first refinement apply, then null. */
export function markFirstRefinement(commandId: string | null | undefined): number | null {
  return markOnce(commandId, 'firstRefinementLoggedAt')
}

/** Test helper — reset module state between unit checks. */
export function resetLatencyForTests(): void {
  timings.clear()
}

/** Format a compact latency summary for DirectorPod console. */
export function formatLatencySummary(commandId: string | null | undefined): string | null {
  if (!commandId) return null
  const timing = timings.get(commandId)
  if (!timing) return null
  const parts: string[] = []
  const add = (label: string, at?: number) => {
    if (at != null) parts.push(`${label} ${((at - timing.sentAt) / 1000).toFixed(2)}s`)
  }
  add('preview', timing.firstPreviewLoggedAt)
  add('cursor', timing.firstCursorMoveLoggedAt)
  add('packet', timing.firstPacketLoggedAt)
  add('apply', timing.firstApplyLoggedAt)
  add('refine', timing.firstRefinementLoggedAt)
  return parts.length > 0 ? `⏱ ${parts.join(' · ')}` : null
}
