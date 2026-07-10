/**
 * Keyframe preset builders shared by the editor UI and Director Mode agents.
 * All values follow the store convention: world-space euler XYZ radians.
 */

export type PresetKeyframes = Array<{ time: number; value: [number, number, number] }>

const TURNAROUND_STEPS = 32
const ORBIT_STEPS = 64

/** 360° yaw across `duration`, preserving base pitch/roll. */
export function buildTurnaroundRotationKeyframes(
  baseRotation: [number, number, number],
  duration: number
): PresetKeyframes {
  const [rx, , rz] = baseRotation
  const startY = baseRotation[1]
  const out: PresetKeyframes = []
  for (let i = 0; i <= TURNAROUND_STEPS; i++) {
    const alpha = i / TURNAROUND_STEPS
    out.push({
      time: alpha * duration,
      value: [rx, startY + alpha * Math.PI * 2, rz],
    })
  }
  return out
}

/** Circle around `center` at `orbitRadius` (or inferred from object offset). */
export function buildOrbitPositionKeyframes(
  basePosition: [number, number, number],
  duration: number,
  center: [number, number, number] = [0, 0, 0],
  orbitRadius?: number
): PresetKeyframes {
  const [x, y, z] = basePosition
  const [cx, , cz] = center
  const dx = x - cx
  const dz = z - cz
  const radius = orbitRadius ?? Math.max(0.5, Math.hypot(dx, dz))
  const startTheta = Math.atan2(dx, dz)
  const out: PresetKeyframes = []
  for (let i = 0; i <= ORBIT_STEPS; i++) {
    const alpha = i / ORBIT_STEPS
    const theta = startTheta + alpha * Math.PI * 2
    out.push({
      time: alpha * duration,
      value: [cx + radius * Math.sin(theta), y, cz + radius * Math.cos(theta)],
    })
  }
  return out
}

export interface BounceHop {
  start: number
  end: number
  height: number
}

/**
 * Hop schedule under gravity: duration ∝ √height so small hops are snappier.
 * Times are normalized to [0, duration].
 */
export function buildBounceHopSchedule(
  duration: number,
  height: number,
  hops: number,
  decay: number
): BounceHop[] {
  const hopCount = Math.max(1, Math.round(hops))
  const heights = Array.from({ length: hopCount }, (_, i) => height * Math.pow(decay, i))
  const weights = heights.map((h) => Math.sqrt(Math.max(h, 1e-4)))
  const weightSum = weights.reduce((a, b) => a + b, 0)
  const schedule: BounceHop[] = []
  let t = 0
  for (let i = 0; i < hopCount; i++) {
    const span = (weights[i] / weightSum) * duration
    schedule.push({ start: t, end: t + span, height: heights[i] })
    t += span
  }
  schedule[schedule.length - 1].end = duration
  return schedule
}

/** Ballistic hops — gravity-asymmetric timing, light lateral drift, settle on last land. */
export function buildBouncePositionKeyframes(
  basePosition: [number, number, number],
  duration: number,
  height = 1.5,
  hops = 2,
  decay = 0.55,
  seed = 0
): PresetKeyframes {
  const [x, y, z] = basePosition
  const schedule = buildBounceHopSchedule(duration, height, hops, decay)
  const out: PresetKeyframes = [{ time: 0, value: [x, y, z] }]
  const samplesPerHop = 16
  const angle = ((seed % 1000) / 1000) * Math.PI * 2
  const driftScale = Math.max(0.06, height * 0.18)

  let fromX = x
  let fromZ = z
  for (let h = 0; h < schedule.length; h++) {
    const hop = schedule[h]
    const hopDrift =
      driftScale * (0.25 + (((seed + h * 17) % 1000) / 1000) * 0.55) * Math.pow(decay, h * 0.5)
    const toX = x + Math.cos(angle + h * 0.7) * hopDrift * (h + 1)
    const toZ = z + Math.sin(angle + h * 0.7) * hopDrift * (h + 1)
    for (let i = 1; i <= samplesPerHop; i++) {
      const local = i / samplesPerHop
      const arc = 4 * local * (1 - local)
      out.push({
        time: hop.start + local * (hop.end - hop.start),
        value: [
          fromX + (toX - fromX) * local,
          y + arc * hop.height,
          fromZ + (toZ - fromZ) * local,
        ],
      })
    }
    fromX = toX
    fromZ = toZ
  }

  out.push({ time: duration, value: [fromX, y, fromZ] })
  return out
}

/**
 * Classic squash-and-stretch coupled to bounce impacts.
 * Stretch on takeoff/apex energy; flatten on land; recover before next hop.
 */
export function buildBounceScaleKeyframes(
  baseScale: [number, number, number],
  duration: number,
  hops = 2,
  decay = 0.55,
  flat = 0.55
): PresetKeyframes {
  const [sx, sy, sz] = baseScale
  const schedule = buildBounceHopSchedule(duration, 1, hops, decay)
  const stretch = 1 + (1 - flat) * 0.45
  const out: PresetKeyframes = [{ time: 0, value: [sx, sy, sz] }]

  for (let h = 0; h < schedule.length; h++) {
    const hop = schedule[h]
    const span = hop.end - hop.start
    const impactFlat = flat + (1 - flat) * (1 - Math.pow(decay, h)) * 0.35
    const impactStretch = 1 + (1 - impactFlat) * 0.5
    // Anticipation stretch leaving the ground
    out.push({
      time: hop.start + span * 0.08,
      value: [sx / stretch, sy * stretch, sz / stretch],
    })
    // Near apex — ease back toward rest
    out.push({
      time: hop.start + span * 0.45,
      value: [sx, sy, sz],
    })
    // Impact squash
    out.push({
      time: hop.end - span * 0.04,
      value: [sx * impactStretch, sy * impactFlat, sz * impactStretch],
    })
    // Recover
    out.push({
      time: Math.min(duration, hop.end + span * 0.06),
      value: [sx, sy, sz],
    })
  }

  out.push({ time: duration, value: [sx, sy, sz] })
  // Sort + dedupe by time for clean tracks
  const byTime = new Map<number, [number, number, number]>()
  for (const key of out) byTime.set(Math.round(key.time * 1000) / 1000, key.value)
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time, value }))
}
