/**
 * What the set remembers about you.
 *
 * Ambient intelligence is supposed to adapt to behaviour, and adaptation that
 * resets every session isn't adaptation. This is a deliberately small profile —
 * how far out you actually put the set, how long you leave between takes,
 * whether you've found your feet — kept in localStorage and used to bias a
 * handful of defaults so the second session fits better than the first.
 *
 * Small and local on purpose. No account, no server, no sync: the project's
 * whole stance is "no backend, no accounts, no API keys", and a preference file
 * that follows you around would be a different product.
 *
 * The merge/summarise functions are pure so they can be unit tested; storage
 * access is guarded the same way xr-coach guards it, so a private-mode browser
 * or a node runtime degrades to "no memory" rather than throwing.
 */

const STORAGE_KEY = 'sikat.xr.profile'
const VERSION = 1

/** Keep the tail short — recent habits beat a lifetime average on a film set. */
const MAX_SAMPLES = 12
/** Below this many sessions the profile isn't trusted to bias anything. */
const CONFIDENT_SESSIONS = 2

/**
 * Deliberately one habit, not a dossier. The version field is here so this can
 * grow later without trusting old records; what it should not grow is fields
 * nothing reads. "Have they been oriented" already lives in xr-coach's own
 * storage key, and duplicating it here would just create two answers.
 */
export interface DirectorProfile {
  version: number
  /** How many XR sessions this director has started. */
  sessions: number
  /** Recent stage standoff distances, metres, newest last. */
  standoffs: number[]
}

const EMPTY: DirectorProfile = {
  version: VERSION,
  sessions: 0,
  standoffs: [],
}

// ---- pure core ----

/** Median, because one odd take shouldn't drag the whole habit. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** Append a sample, keeping only the recent tail. */
export function pushSample(samples: number[], value: number): number[] {
  if (!Number.isFinite(value)) return samples
  const next = [...samples, value]
  return next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next
}

/**
 * Normalise whatever came out of storage. Anything unrecognised — a future
 * version, a hand-edited file, a half-written record — degrades to a fresh
 * profile rather than propagating bad numbers into stage placement.
 */
export function migrateProfile(raw: unknown): DirectorProfile {
  if (!raw || typeof raw !== 'object') return { ...EMPTY }
  const p = raw as Partial<DirectorProfile>
  if (p.version !== VERSION) return { ...EMPTY }
  const numbers = (v: unknown): number[] =>
    Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)).slice(-MAX_SAMPLES) : []
  return {
    version: VERSION,
    sessions: typeof p.sessions === 'number' && p.sessions >= 0 ? Math.floor(p.sessions) : 0,
    standoffs: numbers(p.standoffs),
  }
}

/** True once there's enough history to bias anything on. */
export function isProfileConfident(p: DirectorProfile): boolean {
  return p.sessions >= CONFIDENT_SESSIONS
}

/**
 * The standoff to actually use, given a default and what this director keeps
 * doing. Blended rather than replaced — a habit is evidence, not an instruction,
 * and a single strange session shouldn't move the set two metres.
 */
export function preferredStandoff(p: DirectorProfile, fallback: number, clamp: [number, number]): number {
  if (!isProfileConfident(p)) return fallback
  const habit = median(p.standoffs)
  if (habit === null) return fallback
  const blended = fallback * 0.4 + habit * 0.6
  return Math.min(clamp[1], Math.max(clamp[0], blended))
}

// ---- storage shell ----

let cached: DirectorProfile | null = null

function read(): DirectorProfile {
  if (cached) return cached
  try {
    if (typeof localStorage === 'undefined') {
      cached = { ...EMPTY }
      return cached
    }
    const raw = localStorage.getItem(STORAGE_KEY)
    cached = migrateProfile(raw ? JSON.parse(raw) : null)
  } catch {
    // Private mode, quota, or corrupt JSON — no memory is a fine outcome.
    cached = { ...EMPTY }
  }
  return cached
}

function write(next: DirectorProfile): void {
  cached = next
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    }
  } catch {
    // Keep the in-memory copy; it still helps for the rest of the session.
  }
}

export function getProfile(): DirectorProfile {
  return read()
}

/** Call once when an XR session gets its first tracked frame. */
export function noteSessionStart(): void {
  const p = read()
  write({ ...p, sessions: p.sessions + 1 })
}

export function noteStandoff(metres: number): void {
  const p = read()
  write({ ...p, standoffs: pushSample(p.standoffs, metres) })
}

/** Test hook — drops the cache so the next read hits storage again. */
export function resetProfileCacheForTest(): void {
  cached = null
}
