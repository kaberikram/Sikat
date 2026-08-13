/**
 * Pure helpers for carrying the set with the stage ring.
 * XR moves stage.position in world space; objects sit at absolute coords —
 * without a matching translate they stay at the guardian origin underfoot.
 */

export type V3 = [number, number, number]

const EPS = 1e-9

export function vecDelta(from: V3, to: V3): V3 {
  return [to[0] - from[0], to[1] - from[1], to[2] - from[2]]
}

export function isNearZeroDelta(d: V3): boolean {
  return Math.hypot(d[0], d[1], d[2]) < EPS
}

export function addVec(a: V3, d: V3): V3 {
  return [a[0] + d[0], a[1] + d[1], a[2] + d[2]]
}

export interface StageKeyframe {
  time: number
  property: 'position' | 'rotation' | 'scale'
  value: V3
}

/** Shift base position and every position keyframe by delta. */
export function translateObjectPose(
  position: V3,
  keyframes: StageKeyframe[],
  delta: V3
): { position: V3; keyframes: StageKeyframe[] } {
  return {
    position: addVec(position, delta),
    keyframes: keyframes.map((kf) =>
      kf.property === 'position' ? { ...kf, value: addVec(kf.value, delta) } : kf
    ),
  }
}
