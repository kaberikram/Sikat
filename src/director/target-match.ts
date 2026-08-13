/**
 * Matching a spoken or model-written name to something actually on set.
 *
 * The crew names things loosely — "the ball", "HERO_SPHERE", "hero", "that
 * sphere" — and the set is full of `SPHERE_AGT_01` and `SNEAKER_ONE`. The old
 * resolver did exact-id, one hard-coded `"ball"` case, exact name, then
 * `object.name.includes(needle)`. That last check runs one way only, so
 * `HERO_SPHERE` could not match a `SPHERE_AGT_01` or a `HERO` standing right
 * there — the needle has to be inside the name, never the reverse.
 *
 * Pure and free of runtime imports so it can be unit tested directly.
 */

/** Primitive words that name a *kind* of thing rather than a specific one. */
const TYPE_WORDS: Record<string, string[]> = {
  sphere: ['sphere', 'ball', 'orb', 'globe'],
  box: ['box', 'cube', 'block'],
  cone: ['cone'],
  cylinder: ['cylinder', 'tube', 'pillar', 'column'],
  torus: ['torus', 'donut', 'doughnut', 'ring'],
  plane: ['plane', 'floor', 'ground'],
  text: ['text', 'title', 'sign', 'label', 'card'],
  // Deliberately no "hero" here. Hero is a *role* — the thing a shot is about —
  // and any primitive can hold it. Listing it as a sneaker synonym made
  // HERO_SPHERE resolve to a sneaker, and made "spawn what the name asks for"
  // answer sneaker instead of sphere.
  sneaker: ['sneaker', 'shoe', 'trainer'],
}

/** Filler that carries no identity — dropped before scoring. */
const STOPWORDS = new Set(['the', 'a', 'an', 'that', 'this', 'my', 'our', 'agt'])

/** Split a name into comparable tokens: `HERO_SPHERE` → `["hero","sphere"]`. */
export function tokenize(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0 && !STOPWORDS.has(t) && !/^\d+$/.test(t))
}

/** The primitive kind a token names, if any. */
function typeOf(token: string): string | null {
  for (const kind in TYPE_WORDS) {
    if (TYPE_WORDS[kind].includes(token)) return kind
  }
  return null
}

export interface Candidate {
  id: string
  name: string
}

/**
 * Score how well a candidate answers to `needle`. 0 means no relationship.
 *
 * Deliberately ordered so a real exact match can never lose to a fuzzy one:
 * exact name outranks every token score, and token overlap outranks a bare
 * type-word match.
 */
export function scoreMatch(needle: string, candidateName: string): number {
  const a = needle.trim().toLowerCase()
  const b = candidateName.trim().toLowerCase()
  if (!a || !b) return 0
  if (a === b) return 1000

  const at = tokenize(needle)
  const bt = tokenize(candidateName)
  if (at.length === 0 || bt.length === 0) return 0

  const bSet = new Set(bt)
  const shared = at.filter((t) => bSet.has(t))
  if (shared.length > 0) {
    // Overlap relative to the shorter side, so `HERO_SPHERE` vs `SPHERE_AGT_01`
    // scores on the word they genuinely share rather than being punished for
    // the suffix nobody said out loud.
    const coverage = shared.length / Math.min(at.length, bt.length)
    return 100 + Math.round(coverage * 100)
  }

  // Nothing shared literally — do they at least name the same kind of thing?
  const aTypes = new Set(at.map(typeOf).filter(Boolean) as string[])
  const bTypes = new Set(bt.map(typeOf).filter(Boolean) as string[])
  for (const t of aTypes) if (bTypes.has(t)) return 50

  // Substring either direction, as a last resort before giving up.
  if (b.includes(a) || a.includes(b)) return 10
  return 0
}

/**
 * Best match for `needle` among `candidates`, or null when nothing plausibly
 * answers to it. Ties go to the earlier candidate, which keeps the choice
 * stable across calls.
 */
export function bestMatch(needle: string, candidates: Candidate[]): Candidate | null {
  let best: Candidate | null = null
  let bestScore = 0
  for (const c of candidates) {
    const score = scoreMatch(needle, c.name)
    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }
  return best
}

/**
 * The primitive to create when a name resolves to nothing on set. Reads the
 * name's own tokens — `HERO_SPHERE` asked for a sphere — and falls back to a
 * sphere, which reads as a subject rather than as scenery.
 */
export function primitiveForName(name: string): string {
  for (const token of tokenize(name)) {
    const kind = typeOf(token)
    if (kind) return kind
  }
  return 'sphere'
}
