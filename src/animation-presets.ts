/**
 * Keyframe preset builders shared by the editor UI and Director Mode agents.
 * All values follow the store convention: world-space euler XYZ radians.
 */

export type PresetKeyframes = Array<{ time: number; value: [number, number, number] }>

const TURNAROUND_STEPS = 8

/** 360° yaw across `duration`, preserving base pitch/roll. (Moved from Editor.tsx.) */
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

/** Circle around the world origin at the object's current radius and height. */
export function buildOrbitPositionKeyframes(
  basePosition: [number, number, number],
  duration: number
): PresetKeyframes {
  const [x, y, z] = basePosition
  const radius = Math.max(0.5, Math.hypot(x, z))
  const startTheta = Math.atan2(x, z)
  const out: PresetKeyframes = []
  for (let i = 0; i <= ORBIT_STEPS; i++) {
    const alpha = i / ORBIT_STEPS
    const theta = startTheta + alpha * Math.PI * 2
    out.push({
      time: alpha * duration,
      value: [radius * Math.sin(theta), y, radius * Math.cos(theta)],
    })
  }
  return out
}

/** Two decaying hops; interpolation is linear so each arc is sampled. */
export function buildBouncePositionKeyframes(
  basePosition: [number, number, number],
  duration: number,
  height = 1.5
): PresetKeyframes {
  const [x, y, z] = basePosition
  const out: PresetKeyframes = []
  const samples = 24
  for (let i = 0; i <= samples; i++) {
    const alpha = i / samples
    // |sin| gives repeated hops; decay shrinks each one
    const hops = 2
    const decay = 1 - alpha * 0.5
    const lift = Math.abs(Math.sin(alpha * Math.PI * hops)) * height * decay
    out.push({ time: alpha * duration, value: [x, y + lift, z] })
  }
  return out
}
