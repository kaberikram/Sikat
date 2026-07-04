/**
 * Keyframe preset builders shared by the editor UI and Director Mode agents.
 * All values follow the store convention: world-space euler XYZ radians.
 */

export type PresetKeyframes = Array<{ time: number; value: [number, number, number] }>

const TURNAROUND_STEPS = 8

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

const ORBIT_STEPS = 16

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

/** Discrete parabolic hops — 2 vs 3 hops look clearly different; seed adds drift. */
export function buildBouncePositionKeyframes(
  basePosition: [number, number, number],
  duration: number,
  height = 1.5,
  hops = 2,
  decay = 0.55,
  seed = 0
): PresetKeyframes {
  const [x, y, z] = basePosition
  const hopCount = Math.max(1, Math.round(hops))
  const out: PresetKeyframes = []
  const samplesPerHop = 10
  const angle = ((seed % 1000) / 1000) * Math.PI * 2
  const driftScale = Math.max(0.08, height * 0.22)

  out.push({ time: 0, value: [x, y, z] })

  let px = x
  let pz = z
  for (let h = 0; h < hopCount; h++) {
    const hopHeight = height * Math.pow(decay, h)
    const hopStart = h / hopCount
    const hopEnd = (h + 1) / hopCount
    const hopDrift =
      driftScale * (0.35 + (((seed + h * 17) % 1000) / 1000) * 0.65)
    px += Math.cos(angle + h * 0.85) * hopDrift
    pz += Math.sin(angle + h * 0.85) * hopDrift
    for (let i = 1; i <= samplesPerHop; i++) {
      const local = i / samplesPerHop
      const globalT = hopStart + local * (hopEnd - hopStart)
      const arc = 4 * local * (1 - local)
      const settle = 1 - local
      out.push({
        time: globalT * duration,
        value: [
          x + (px - x) * settle,
          y + arc * hopHeight,
          z + (pz - z) * settle,
        ],
      })
    }
  }

  out.push({ time: duration, value: [x, y, z] })
  return out
}
