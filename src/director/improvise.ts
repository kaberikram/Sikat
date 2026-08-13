/**
 * Improvisation — the set moves before anyone has finished thinking.
 *
 * An open-ended brief ("surprise me", "do crazy motion graphics") has no local
 * grammar match, so it went straight to the server and the director watched
 * nothing until the round-trip came back. When that round-trip was slow, or the
 * plan produced nothing, they watched nothing and then got an error.
 *
 * This choreographs a real take immediately from the local vocabulary —
 * `motion-synth.ts` already ships 21 motions — across whatever is actually on
 * set. It is deterministic, needs no server and no API key, and runs in the same
 * frame the words land. The LLM's richer plan still arrives and supersedes it
 * through the runtime's existing barge-in, so this is a floor, not a ceiling.
 *
 * The planning decisions are pure so they can be unit tested; the caller turns
 * the result into packets.
 */
import type { MotionId } from '../motion-synth'
import type { LocalPacketSpec } from './local-grammar'

/** Motions that read well without knowing anything about the object. */
const SAFE_MOTIONS: MotionId[] = [
  'float',
  'spin',
  'bounce',
  'orbit',
  'sway',
  'figure8',
  'spiral',
  'wobble',
  'swing',
  'pulse',
  'zigzag',
  'drift',
]

/** Beats between each object starting, so a take reads as choreography. */
const STAGGER_SEC = 0.35
/** A take long enough to watch, short enough not to feel like a screensaver. */
const TAKE_SEC = 6

/** Name for the subject conjured when there is nothing on set to direct. */
export const IMPROVISED_HERO = 'HERO_SPHERE'

export interface StageObject {
  id: string
  name: string
}

export interface ImprovisedBeat {
  target: string
  motion: MotionId
  durationSec: number
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
        motion: SAFE_MOTIONS[seedAt(seed, 0) % SAFE_MOTIONS.length],
        durationSec: TAKE_SEC,
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
    // Offset the salt per object so neighbours don't land on the same motion.
    motion: SAFE_MOTIONS[seedAt(seed, i + 1) % SAFE_MOTIONS.length],
    durationSec: TAKE_SEC,
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
    specs.push({
      agent: 'AssetAnimator',
      body: {
        command: 'ANIMATE_OBJECT',
        payload: {
          target: { name: beat.target },
          motion: beat.motion,
          durationSec: beat.durationSec,
          params: { delaySec: beat.delaySec },
        },
      },
    })
  }
  // No PLAYBACK packet: local specs only address the three crew agents, and
  // transport is a store action here — the caller rolls the timeline once the
  // keyframes are authored, exactly as the spoken transport cues do.
  return specs
}
