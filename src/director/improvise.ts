/**
 * Seeded choreography — a take authored from nothing but the cast and a phrase.
 *
 * Used by SET DAY to give the set a shot with no server involved. It used to
 * also answer arbitrary commands the crew couldn't reach, which is exactly the
 * canned-feeling behaviour we removed: when there is a crew, they interpret,
 * and when there isn't, the set says so rather than guessing.
 *
 * The planning decisions are pure so they can be unit tested; the caller turns
 * the result into packets.
 */
import type { LocalPacketSpec } from './local-grammar'
import type { Vec3 } from './protocol'

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
