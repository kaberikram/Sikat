/**
 * Smooth position-track interpolation reused by Scene, sync, and exporter.
 *
 * Position uses a centripetal Catmull-Rom curve so sparse director keyframes
 * read as a designed path instead of straight robot segments. Scale and Euler
 * rotation intentionally stay linear: overshoot on those tracks is surprising.
 */
type Vec3 = [number, number, number]

interface Keyframe {
  time: number
  property: string
  value: Vec3
}

function linear(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ]
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function interpolateAt(a: Vec3, b: Vec3, ta: number, tb: number, t: number): Vec3 {
  if (Math.abs(tb - ta) < 1e-6) return a
  return linear(a, b, (t - ta) / (tb - ta))
}

function centripetalCatmullRom(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const t0 = 0
  const t1 = t0 + Math.sqrt(Math.max(distance(p0, p1), 1e-4))
  const t2 = t1 + Math.sqrt(Math.max(distance(p1, p2), 1e-4))
  const t3 = t2 + Math.sqrt(Math.max(distance(p2, p3), 1e-4))
  const u = t1 + (t2 - t1) * t
  const a1 = interpolateAt(p0, p1, t0, t1, u)
  const a2 = interpolateAt(p1, p2, t1, t2, u)
  const a3 = interpolateAt(p2, p3, t2, t3, u)
  const b1 = interpolateAt(a1, a2, t0, t2, u)
  const b2 = interpolateAt(a2, a3, t1, t3, u)
  return interpolateAt(b1, b2, t1, t2, u)
}

export function interpolateKeyframes(
  keyframes: Keyframe[],
  time: number,
  property: string,
  defaultValue: Vec3
): Vec3 {
  const kf = keyframes.filter((k) => k.property === property).sort((a, b) => a.time - b.time)
  if (kf.length === 0) return defaultValue
  if (kf.length === 1) return kf[0].value

  const nextIdx = kf.findIndex((k) => k.time > time)
  if (nextIdx === -1) return kf[kf.length - 1].value
  if (nextIdx === 0) return kf[0].value

  const prev = kf[nextIdx - 1]
  const next = kf[nextIdx]

  const alpha = (time - prev.time) / (next.time - prev.time)
  if (property !== 'position' || kf.length < 4) return linear(prev.value, next.value, alpha)

  const p0 = kf[Math.max(0, nextIdx - 2)].value
  const p3 = kf[Math.min(kf.length - 1, nextIdx + 1)].value
  return centripetalCatmullRom(p0, prev.value, next.value, p3, alpha)
}
