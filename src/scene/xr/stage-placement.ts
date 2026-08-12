/**
 * Stage placement math — pure, no three.js, so it's node:test-able.
 *
 * On local-floor the world origin is the guardian center at floor level, so a
 * default stage of [0,0,0] builds the set at the user's FEET. These helpers
 * compute a comfortable spot ~2m ahead of wherever the user is actually
 * standing and facing when the session's first tracked frame arrives.
 */

export type V3 = [number, number, number]

/** Stage center lands this far ahead of the head (stage radius + breathing room). */
export const STAGE_STANDOFF_M = 1.9

/**
 * How far the set may be placed once a director's own habit is taken into
 * account. Close enough to reach, far enough to frame a wide.
 */
export const STANDOFF_RANGE: [number, number] = [1.3, 2.8]

/** Re-place the set on "crew, set the stage" only after a real move. */
export const REPLACE_THRESHOLD_M = 0.75

/** Flatten a look direction onto the floor plane. Null when looking straight up/down. */
export function flattenForward(forward: V3): V3 | null {
  const [x, , z] = forward
  const len = Math.hypot(x, z)
  if (len < 0.1) return null
  return [x / len, 0, z / len]
}

/**
 * True once the head pose is real tracking data. At session start the head
 * sits at identity (origin) for a few frames — placing anything from that pose
 * puts it inside the floor at guardian center.
 */
export function isHeadPoseValid(headPos: V3): boolean {
  const [x, y, z] = headPos
  if (x === 0 && y === 0 && z === 0) return false
  return y > 0.5 && y < 2.5
}

/**
 * Where the stage should sit for a user at `headPos` looking along `headForward`.
 *
 * `standoff` defaults to the house distance; callers who know this director's
 * habit pass their own, so a returning director finds the set where they keep
 * putting it.
 */
export function computeStagePose(
  headPos: V3,
  headForward: V3,
  standoff: number = STAGE_STANDOFF_M
): { position: V3 } {
  const flat = flattenForward(headForward) ?? [0, 0, -1]
  return {
    position: [headPos[0] + flat[0] * standoff, 0, headPos[2] + flat[2] * standoff],
  }
}

/** How far the set actually ended up from the head — the sample worth remembering. */
export function standoffBetween(headPos: V3, stagePos: V3): number {
  return Math.hypot(stagePos[0] - headPos[0], stagePos[2] - headPos[2])
}

/** Re-place only when the newly computed spot is meaningfully far from the current one. */
export function shouldReplaceStage(
  headPos: V3,
  headForward: V3,
  stagePos: V3,
  standoff: number = STAGE_STANDOFF_M
): boolean {
  const next = computeStagePose(headPos, headForward, standoff).position
  const dx = next[0] - stagePos[0]
  const dz = next[2] - stagePos[2]
  return Math.hypot(dx, dz) > REPLACE_THRESHOLD_M
}
