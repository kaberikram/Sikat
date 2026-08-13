/**
 * Link health policy — when a socket counts as dead, and which unsent commands
 * are still worth replaying when it comes back.
 *
 * The rules live here, pure, so they can be unit tested away from timers and
 * WebSockets. `socket.ts` is the stateful shell that applies them. Same split
 * as `cursor-lifecycle.ts` and `ambient-sense.ts`.
 */

/**
 * No inbound frame for this long means the link is gone, whatever the browser
 * says about `readyState`.
 *
 * This has to outlast the slowest thing that can legitimately go quiet — an
 * LLM command in flight sends nothing back until the first packet — or a slow
 * answer would be mistaken for a dead socket and the reconnect would cancel
 * the very command it was waiting on. Thirty seconds is comfortably past the
 * command budget and still short enough that a dead link is caught before the
 * director has finished wondering why nothing happened.
 */
export const LIVENESS_TIMEOUT_MS = 30_000

/** How often to prove the link is alive when nothing else is talking. */
export const PING_INTERVAL_MS = 20_000

/**
 * The whole budget for one command, from send to the crew answering.
 *
 * One number, shared, because three unrelated ones is what produced the worst
 * failure in the pod: the cursors gave up at 10s, the input kept saying "crew is
 * working…" until 30s, and the server kept going to 45s — so a slow command
 * looked abandoned for twenty seconds and could still land afterwards with no
 * cursor to attribute it to.
 *
 * Twelve seconds is past the p99 of a streaming plan and still inside the span
 * where a director is plausibly still waiting rather than assuming it broke.
 * When it expires the crew improvises rather than apologising, so this is a
 * handover point, not a failure.
 */
export const COMMAND_BUDGET_MS = 12_000

/**
 * True when nothing has arrived for longer than the budget.
 *
 * `lastInboundAt <= 0` means nothing has ever arrived on this connection, which
 * is the state a socket is in between `new WebSocket()` and its first frame —
 * not evidence of death.
 */
export function linkExpired(
  lastInboundAt: number,
  now: number,
  budgetMs = LIVENESS_TIMEOUT_MS
): boolean {
  if (lastInboundAt <= 0) return false
  return now - lastInboundAt >= budgetMs
}

// ---- what the pod says about the link ----

export type LinkMode = 'open' | 'connecting' | 'reconnecting' | 'local-crew' | 'unconfigured'

/**
 * Read the link's state the way a director needs it, not the way the socket
 * reports it.
 *
 * `closed` is the same raw status for three different situations, and they mean
 * opposite things: no server exists in this build, no server has ever answered
 * (calm — the local crew runs the set), or the server was there a second ago and
 * is now gone (something is wrong and commands are being held). Rendering the
 * raw status made a live reconnect read as a permanent failure.
 */
export function linkMode(opts: {
  status: 'connecting' | 'open' | 'closed'
  configured: boolean
  everConnected: boolean
  /** Failed connection attempts so far — 0 while the very first one is open. */
  attempts: number
}): LinkMode {
  if (!opts.configured) return 'unconfigured'
  if (opts.status === 'open') return 'open'
  // Having connected once makes silence a fault rather than a configuration.
  if (opts.everConnected) return 'reconnecting'
  // A server that has never answered is a *mode*, not an error, and it stays
  // that way while the socket quietly keeps retrying — flipping to "connecting"
  // on every retry tick is the calm local-crew state flickering into something
  // that reads as broken. Only the genuine first attempt shows as connecting.
  if (opts.attempts === 0 && opts.status === 'connecting') return 'connecting'
  return 'local-crew'
}

/** The one-line status the pod prints, including anything the link owes. */
export function linkLabel(mode: LinkMode, heldCount = 0): string {
  if (mode === 'reconnecting') {
    return heldCount > 0 ? `reconnecting · ${heldCount} held` : 'reconnecting'
  }
  if (mode === 'unconfigured') return 'no crew server'
  if (mode === 'local-crew') return 'local crew'
  return mode
}

// ---- outbound queue ----

/**
 * How long a command may sit unsent before replaying it would be a surprise
 * rather than a repair.
 *
 * A director who said "make it gold" twenty seconds ago and saw nothing happen
 * has moved on. Replaying it then is the set acting on a stale intention, which
 * costs more trust than dropping it.
 */
export const QUEUE_MAX_AGE_MS = 20_000

/** Beyond this the backlog stops being a repair and becomes a replay of a session. */
export const QUEUE_MAX_ENTRIES = 5

export interface QueuedAt {
  queuedAt: number
}

/** Drop entries that have aged out. Order is preserved. */
export function pruneQueue<T extends QueuedAt>(
  queue: readonly T[],
  now: number,
  maxAgeMs = QUEUE_MAX_AGE_MS
): T[] {
  return queue.filter((entry) => now - entry.queuedAt < maxAgeMs)
}

/**
 * Add a command to the backlog, pruning stale entries and capping the length.
 *
 * When the cap is hit the *oldest* entry goes, not the newest: the most recent
 * thing the director said is the one they are still waiting on.
 */
export function admitToQueue<T extends QueuedAt>(
  queue: readonly T[],
  entry: T,
  now: number,
  opts?: { maxAgeMs?: number; maxEntries?: number }
): T[] {
  const maxEntries = opts?.maxEntries ?? QUEUE_MAX_ENTRIES
  const next = pruneQueue(queue, now, opts?.maxAgeMs)
  next.push(entry)
  return next.length > maxEntries ? next.slice(next.length - maxEntries) : next
}
