/**
 * Improvisation — the set moves before anyone has finished thinking.
 *
 * An open-ended brief has no local grammar match, so it used to go straight
 * to the server and the director watched nothing until the round-trip came
 * back. This authors a unique seeded position path immediately against
 * whatever is on set. The LLM's richer plan still arrives and supersedes it
 * through barge-in (SET_KEYFRAMES replaces SET_KEYFRAMES / ANIMATE_OBJECT
 * on the same object), so this is a floor, not a ceiling.
 *
 * The planning decisions are pure so they can be unit tested; the caller turns
 * the result into packets.
 */
// Extension required: this is a value import, and the node:test runner resolves
// ESM strictly (type-only imports are erased, so the rest of the file is fine).
import { COLORS, FX_SECTIONS, lightsSpec, MOODS, type LocalPacketSpec } from './local-grammar.ts'
import type { FxSection, UpdateLightsPayload, Vec3 } from './protocol'
import { bestMatch } from './target-match.ts'

/** Beats between each object starting, so a take reads as choreography. */
const STAGGER_SEC = 0.35
/** A take long enough to watch, short enough not to feel like a screensaver. */
const TAKE_SEC = 6
const PATH_TIMES = [0, 0.5, 1.1, 1.9, 2.8, 3.9, 5.0, 6.0] as const

/** Name for the subject conjured when there is nothing on set to direct. */
export const IMPROVISED_HERO = 'HERO_SPHERE'

export interface StageObject {
  id: string
  name: string
  position?: Vec3
}

export interface ImprovisedKeyframe {
  time: number
  value: Vec3
}

export interface ImprovisedBeat {
  target: string
  keyframes: ImprovisedKeyframe[]
  /** Seconds after the take starts that this object begins. */
  delaySec: number
  /** True when this object has to be created first. */
  spawn: boolean
}

/**
 * Deterministic index from a seed, so the same command replays identically but
 * two different commands look different. Small string hash — no crypto needed,
 * and unlike Python's `hash()` this is stable across processes.
 */
function seedAt(seed: string, salt: number): number {
  let h = 2166136261 ^ salt
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

function unitAt(seed: string, salt: number): number {
  return (seedAt(seed, salt) % 1000) / 1000
}

function authoredPath(base: Vec3, seed: string, salt: number): ImprovisedKeyframe[] {
  const travel = 0.35
  const keys: ImprovisedKeyframe[] = []
  for (let i = 0; i < PATH_TIMES.length; i++) {
    const u = unitAt(seed, salt + i + 10)
    const v = unitAt(seed, salt + i + 20)
    const angle = (i / 7) * Math.PI * 2 + u * 0.8
    const lift = (v - 0.5) * travel * 0.8
    const x = base[0] + Math.cos(angle) * travel * (0.6 + u * 0.5)
    const y = Math.max(0.02, base[1] + lift + travel * 0.15)
    const z = base[2] + Math.sin(angle) * travel * (0.6 + v * 0.5)
    keys.push({
      time: PATH_TIMES[i],
      value: [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000, Math.round(z * 1000) / 1000],
    })
  }
  keys[keys.length - 1] = { time: TAKE_SEC, value: keys[0].value }
  return keys
}

/**
 * Choreograph a take across what's on set.
 *
 * With an empty set this returns a single spawned hero rather than nothing —
 * "surprise me" on a bare stage should still produce a shot.
 */
export function choreograph(objects: StageObject[], seed: string): ImprovisedBeat[] {
  if (objects.length === 0) {
    return [
      {
        target: IMPROVISED_HERO,
        keyframes: authoredPath([0, 0.15, 0], seed, 0),
        delaySec: 0,
        spawn: true,
      },
    ]
  }
  // Cap the cast so a busy set doesn't turn into noise — the first few objects
  // carry the shot and the rest hold still, which reads as staging.
  const cast = objects.slice(0, 4)
  return cast.map((obj, i) => ({
    target: obj.name,
    keyframes: authoredPath(obj.position ?? [0, 0, 0], seed, i + 1),
    delaySec: i * STAGGER_SEC,
    spawn: false,
  }))
}

/** Turn beats into the packet specs the local runner already understands. */
export function beatsToSpecs(beats: ImprovisedBeat[]): LocalPacketSpec[] {
  const specs: LocalPacketSpec[] = []
  for (const beat of beats) {
    if (beat.spawn) {
      specs.push({
        agent: 'AssetAnimator',
        body: {
          command: 'SPAWN_OBJECT',
          payload: { primitive: 'sphere', name: beat.target },
        },
      })
    }
    const keyframes =
      beat.delaySec > 0
        ? beat.keyframes.map((k) => ({ time: k.time + beat.delaySec, value: k.value }))
        : beat.keyframes
    specs.push({
      agent: 'AssetAnimator',
      body: {
        command: 'SET_KEYFRAMES',
        payload: {
          target: { name: beat.target },
          property: 'position',
          keyframes,
        },
      },
    })
  }
  // No PLAYBACK packet: local specs only address the three crew agents, and
  // transport is a store action here — the caller rolls the timeline once the
  // keyframes are authored, exactly as the spoken transport cues do.
  return specs
}

// ---------------------------------------------------------------------------
// Reading a sentence loosely
// ---------------------------------------------------------------------------

/**
 * Mood words, read anywhere in a sentence rather than as the whole of it.
 *
 * `parseMood` in the grammar is anchored, so "give me something moody" misses
 * where "moody" hits. These map to the same `MOODS` rigs — the vocabulary is
 * shared, only the strictness differs.
 */
const MOOD_WORDS: [RegExp, keyof typeof MOODS][] = [
  [/\b(golden hour|sunset|warm|amber|dusk|sunrise)\b/, 'goldenHour'],
  [/\b(noir|moody|moonlight|shadowy|dramatic|cinematic|broody)\b/, 'noir'],
  [/\b(neon|cyberpunk|tokyo|synthwave|vaporwave|nightclub|arcade)\b/, 'neon'],
  [/\b(dark(er)?|dim(mer)?|night|gloom|murky|underwater|deep)\b/, 'dim'],
  // No bare colour words here — "make it white" is about an object, and letting
  // it also relight the set means one word quietly does two things.
  [/\b(bright(er)?|daylight|studio|clean|crisp|airy)\b/, 'studio'],
]

/** Vibe words that imply a look rather than naming an effect outright. */
const FX_WORDS: [RegExp, FxSection][] = [
  [/\b(glow(ing)?|shine|shiny|radiant|bloom|dreamy|ethereal|halo)\b/, 'bloom'],
  [/\b(glitch(y|ing)?|broken|corrupt(ed)?|vhs|static)\b/, 'glitch'],
  [/\b(retro|8.?bit|pixel(ated|ate)?|arcade|lo.?fi)\b/, 'pixelate'],
  [/\b(grain(y)?|gritty|film stock|dither(ed)?|noisy)\b/, 'dither'],
  [/\b(toon|cartoon|comic|cel|outline[ds]?|anime)\b/, 'cellShading'],
]

/** Words that plainly ask for movement — the improviser's default anyway. */
const MOTION_HINT =
  /\b(move|spin|turn|rotate|bounce|float|hover|drift|orbit|dance|shake|wobble|sway|rise|drop|fall|fly|swing|travel|circle|loop|animate|motion|choreograph)\b/

function firstMatch<T>(table: [RegExp, T][], text: string): T | null {
  for (const [re, value] of table) if (re.test(text)) return value
  return null
}

/**
 * Which object the director means.
 *
 * Scored through the same resolver the packet applier uses, so "the sneaker"
 * finds `SNEAKER_ONE` and "the ball" finds `SPHERE_AGT_01` — a plain substring
 * test only works when the director says the full generated name, which nobody
 * does. Failing that, "it" is the most recently added thing, which is nearly
 * always what a director means by it: they just put it there.
 */
function subjectFor(objects: StageObject[], text: string): StageObject | null {
  if (objects.length === 0) return null
  // Whole sentence, not word by word: `scoreMatch` tokenizes the needle itself
  // and scores overlap, so it picks the best subject across the set in one pass
  // and short filler words can't win a stray substring match.
  return (bestMatch(text, objects) as StageObject | null) ?? objects[objects.length - 1]
}

function materialSpec(target: string, color: string): LocalPacketSpec {
  return {
    agent: 'LightingTech',
    body: {
      command: 'SET_MATERIAL',
      payload: { target: { name: target }, color },
      transition: { durationSec: 0.8, easing: 'easeOut' },
    },
  }
}

function fxSpec(section: FxSection): LocalPacketSpec {
  return {
    agent: 'VFXOperator',
    body: { command: 'UPDATE_FX', payload: { section, patch: { enabled: true } } },
  }
}

/**
 * Answer *something* to any sentence, from the local vocabulary.
 *
 * The rule that keeps this honest: read the words that are actually there
 * first, and only fall back to motion when the sentence gave nothing else to
 * go on. An improviser that always authors a motion path would answer "make it
 * red" with a wiggle, which reads as the set not listening — worse than the
 * miss it replaced.
 *
 * Pure, so the readings are unit-testable; the caller turns specs into packets.
 */
export function improviseSpecs(objects: StageObject[], text: string): LocalPacketSpec[] {
  const t = text.toLowerCase()
  const specs: LocalPacketSpec[] = []

  const colorWord = Object.keys(COLORS).find((c) => new RegExp(`\\b${c}\\b`).test(t))
  const subject = subjectFor(objects, t)
  if (colorWord && subject) specs.push(materialSpec(subject.name, COLORS[colorWord]))

  const mood = firstMatch(MOOD_WORDS, t)
  // A colour named for an object is about that object, not the rig — only let
  // a bare colour word ("make it all blue") reach the lights.
  if (mood) specs.push(lightsSpec(MOODS[mood] as UpdateLightsPayload))

  // An effect named outright beats a vibe word; both land on the same section.
  const namedFx = Object.keys(FX_SECTIONS).find((k) => t.includes(k))
  const fx = namedFx ? FX_SECTIONS[namedFx] : firstMatch(FX_WORDS, t)
  if (fx) specs.push(fxSpec(fx))

  // Motion when it was asked for, or when nothing above caught — a sentence the
  // set understood no part of still deserves a take rather than a shrug.
  if (MOTION_HINT.test(t) || specs.length === 0) {
    specs.push(...beatsToSpecs(choreograph(objects, text)))
  }
  return specs
}

/** One plain line naming what the crew actually did. */
export function describeImprovisation(specs: LocalPacketSpec[]): string {
  const parts: string[] = []
  const subjects = new Set<string>()
  for (const spec of specs) {
    const body = spec.body
    if (body.command === 'SET_MATERIAL') {
      parts.push(`recoloured ${body.payload.target.name ?? 'the hero'}`)
    } else if (body.command === 'UPDATE_LIGHTS') {
      parts.push('relit the set')
    } else if (body.command === 'UPDATE_FX') {
      parts.push(`pushed ${body.payload.section}`)
    } else if (body.command === 'SET_KEYFRAMES' && body.payload.target?.name) {
      subjects.add(body.payload.target.name)
    }
  }
  if (subjects.size > 0) parts.push(`authored a path on ${[...subjects].join(', ')}`)
  return parts.length > 0 ? `improvised — ${parts.join(', ')}` : 'improvised'
}
