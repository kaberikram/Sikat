/**
 * First-XR-run coach — three short slate lines that teach the controls, shown
 * once per user (localStorage), after the entry cinematic settles. Each line
 * disappears forever the moment the user performs the action it teaches.
 *
 * The coach also reads the room. A director who is clearly hesitating gets more
 * time on each line; one who is moving with intent gets fewer cycles and is let
 * go sooner. Onboarding that erases itself is the point — the pace it erases at
 * should belong to the person, not the clock.
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
/** How far hesitation may stretch a line's dwell (1 = none, 1.8 = nearly double). */
const MAX_PATIENCE = 1.8
/** Below this, a confident director only sees each line once. */
const CONFIDENT_HESITATION = 0.2

const LINES: Array<{ kind: CoachAction; text: string }> = [
  { kind: 'rec', text: 'TRIGGER · FILM' },
  { kind: 'talk', text: 'HOLD A · TALK' },
  { kind: 'stage', text: 'say “crew, set the stage”' },
]

let active = false
let visibleFrom = 0
let learned = new Set<CoachAction>()
/** 0..1 from ambient-sense; 0 means "reads confident". */
let hesitation = 0
/** Monotonic line index, and when the current line began with what dwell. */
let slot = 0
let slotStartedAt = 0
let slotMs = LINE_MS

/**
 * How long each line holds, and how many times the set repeats itself.
 *
 * Hesitation stretches the dwell. Cutting the repeat short needs more than a
 * low reading, though: at the first tracked frame nobody has hesitated yet,
 * because nobody has done anything yet. So confidence has to be *demonstrated*
 * — at least one control already used — before the coach lets go early.
 */
export function coachPacing(h: number, learnedCount: number): { lineMs: number; cycles: number } {
  const eased = Math.min(1, Math.max(0, h))
  const confident = eased < CONFIDENT_HESITATION && learnedCount > 0
  return {
    lineMs: Math.round(LINE_MS * (1 + (MAX_PATIENCE - 1) * eased)),
    cycles: confident ? 1 : CYCLES,
  }
}

/** Feed the coach the current read of the room. Safe to call every frame. */
export function setCoachHesitation(next: number): void {
  hesitation = next
}

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
  slot = 0
  slotStartedAt = 0
  slotMs = LINE_MS
}

/** The line the slate should show right now, or null when coaching is over/idle. */
export function currentCoachHint(nowMs: number): string | null {
  if (!active || nowMs < visibleFrom) return null
  const remaining = LINES.filter((l) => !learned.has(l.kind))
  if (remaining.length === 0) {
    markSeen()
    return null
  }

  // Advance monotonically, latching the pacing when a line begins.
  //
  // This used to derive the slot fresh each frame as
  // `floor((now - visibleFrom) / lineMs)` with `lineMs` recomputed from live
  // hesitation. Hesitation drifts continuously, so `lineMs` moved between 4000
  // and 7200 and the slot index jumped with it — including *backwards*. The
  // coach could show its second line and then its first again. A line's dwell
  // is decided when that line starts and does not change under it.
  if (slotStartedAt === 0) {
    slotStartedAt = visibleFrom
    slotMs = coachPacing(hesitation, learned.size).lineMs
  }
  while (nowMs - slotStartedAt >= slotMs) {
    slotStartedAt += slotMs
    slot += 1
    slotMs = coachPacing(hesitation, learned.size).lineMs
  }

  const { cycles } = coachPacing(hesitation, learned.size)
  if (slot >= remaining.length * cycles) {
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
  hesitation = 0
  slot = 0
  slotStartedAt = 0
  slotMs = LINE_MS
}
