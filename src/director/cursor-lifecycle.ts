/**
 * Cursor lifecycle policy — when a crew cursor may appear, where it belongs,
 * and when it must go away.
 *
 * A cursor is a claim that a named crew member is changing a specific thing,
 * right now. It used to be much looser than that: it appeared on an intent
 * guess, on a server status line, on a suggestion, and on an anonymous
 * "something is coming" anchor floating above the middle of the set. Any of
 * those could be followed by no work at all, and several had no reliable way to
 * retire themselves.
 *
 * The rules live here, pure, so they can be unit tested away from timers,
 * sockets and three.js. `agent-runtime.ts` is the stateful shell that applies
 * them. Same split as `stage-placement.ts` and `ambient-sense.ts`.
 */
import type { CommandPacket, Vec3 } from './protocol'

/**
 * Where a cursor should sit for a packet.
 *
 * `none` is a real answer, not a failure: an object-scoped command whose target
 * didn't resolve has nowhere honest to point, and showing it at the crew's
 * station reads as a cursor appearing at random. Absent beats meaningless.
 */
export type CursorHome =
  | { kind: 'object'; position: Vec3 }
  | { kind: 'station' }
  | { kind: 'none' }

/**
 * Decide a cursor's home.
 *
 * `resolved` is the live world position of the packet's subject. `namedSubject`
 * is whether the packet pointed at one at all — that distinction is the whole
 * point. A packet with no subject is scene-wide (lights, FX, playback, a camera
 * move) and the crew member's own station is a truthful place to stand. A
 * packet that *named* a subject and couldn't find it has nowhere honest to go,
 * and the old behaviour of falling back to the station is exactly the "cursor
 * appears somewhere random" symptom.
 */
export function classifyCursorHome(resolved: Vec3 | null, namedSubject: boolean): CursorHome {
  if (resolved) return { kind: 'object', position: resolved }
  if (namedSubject) return { kind: 'none' }
  return { kind: 'station' }
}

// ---- watchdog ----

/**
 * How long a cursor may stay up without a fresh work beat before it is retired
 * regardless of what any other path believes.
 *
 * This has to outlast the gap between a grammar batch finishing and late LLM
 * motion arriving — that gap is why `markAgentWaiting` exists — or the cursor
 * would flicker out mid-command. Twelve seconds is comfortably past that and
 * still short enough that a genuinely stuck cursor doesn't outstay a take.
 */
export const CURSOR_WATCHDOG_MS = 12_000

export function watchdogExpired(lastBeatAt: number, now: number, budgetMs = CURSOR_WATCHDOG_MS): boolean {
  if (lastBeatAt <= 0) return false
  return now - lastBeatAt >= budgetMs
}

// ---- retirement ----

/**
 * What to do with an "this agent is idle now" signal.
 *
 * The bug this replaces: the old code returned early when a drain looked like
 * it owned the choreography, on the assumption the drain would schedule its own
 * fade. When the drain died — a throw, a cancel, a dropped socket, a session
 * ending — nothing ever did, and the cursor stayed lit forever. `defer` says
 * "the drain will handle it, but remember that a fade is owed", so the watchdog
 * can still collect.
 */
export type IdleDecision = 'fade-now' | 'defer' | 'already-scheduled'

export function idleDecision(opts: {
  phase: string | undefined
  busy: boolean
  hasFadeTimer: boolean
}): IdleDecision {
  if (opts.busy) return 'defer'
  if (opts.hasFadeTimer) return 'already-scheduled'
  // Mid-choreography phases finish on their own, but the fade is still owed.
  if (opts.phase === 'settling' || opts.phase === 'done') return 'defer'
  return 'fade-now'
}
