/**
 * First-XR-run coach — three short slate lines that teach the controls, shown
 * once per user (localStorage), after the entry cinematic settles. Each line
 * disappears forever the moment the user performs the action it teaches.
 *
 * Pure time-driven state (nowMs in, string out) so it's node:test-able;
 * localStorage access is guarded for non-browser runtimes.
 */

export type CoachAction = 'rec' | 'talk' | 'stage'

const STORAGE_KEY = 'sikat.xr.coachSeen'
/** Wait for the entry cinematic (5s) to land before coaching. */
const COACH_DELAY_MS = 5200
const LINE_MS = 4000
const CYCLES = 2

const LINES: Array<{ kind: CoachAction; text: string }> = [
  { kind: 'rec', text: 'TRIGGER · FILM' },
  { kind: 'talk', text: 'HOLD A · TALK' },
  { kind: 'stage', text: 'say “crew, set the stage”' },
]

let active = false
let visibleFrom = 0
let learned = new Set<CoachAction>()

function hasSeen(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return true
  }
}

function markSeen(): void {
  active = false
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, '1')
  } catch {
    // private mode — coach simply shows again next session
  }
}

/** Call at the entry handoff (first tracked frame). No-op after the first run. */
export function startXrCoach(nowMs: number): void {
  if (hasSeen()) return
  active = true
  visibleFrom = nowMs + COACH_DELAY_MS
  learned = new Set()
}

/** The line the slate should show right now, or null when coaching is over/idle. */
export function currentCoachHint(nowMs: number): string | null {
  if (!active || nowMs < visibleFrom) return null
  const remaining = LINES.filter((l) => !learned.has(l.kind))
  if (remaining.length === 0) {
    markSeen()
    return null
  }
  const slot = Math.floor((nowMs - visibleFrom) / LINE_MS)
  if (slot >= remaining.length * CYCLES) {
    markSeen()
    return null
  }
  return remaining[slot % remaining.length].text
}

/** The user did the thing — stop teaching it. All three learned ends the coach. */
export function noteCoachAction(kind: CoachAction): void {
  if (!active) return
  learned.add(kind)
  if (learned.size >= LINES.length) markSeen()
}

export function stopXrCoach(): void {
  active = false
}

/** Test hook — reset module state without touching storage. */
export function resetXrCoachForTest(): void {
  active = false
  visibleFrom = 0
  learned = new Set()
}
