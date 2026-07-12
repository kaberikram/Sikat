/**
 * Layer oscillation motions on top of an existing position path instead of
 * replacing it — e.g. "bounce while moving along the path you set".
 */
import { interpolateKeyframes } from './keyframe-interpolation'
import { buildBounceHopSchedule, DEFAULT_BOUNCE_DECAY, type PresetKeyframes } from './animation-presets'
import { resolveMotionId, type MotionId, type MotionParams } from './motion-synth'

export type Vec3 = [number, number, number]

const PATH_COMPOSITE_MOTIONS = new Set<MotionId>(['bounce', 'float', 'shake', 'pop'])

function toInterpKeyframes(path: PresetKeyframes) {
  return path.map((k) => ({ time: k.time, property: 'position' as const, value: k.value }))
}

export function pathHasTravel(path: PresetKeyframes, stageRadius: number): boolean {
  if (path.length < 2) return false
  const threshold = Math.max(0.4, stageRadius * 0.035)
  const [ox, , oz] = path[0].value
  let maxDist = 0
  for (const p of path) {
    maxDist = Math.max(maxDist, Math.hypot(p.value[0] - ox, p.value[2] - oz))
  }
  return maxDist >= threshold
}

export function canCompositeOntoPath(motionRaw: string, path: PresetKeyframes, stageRadius: number): boolean {
  const motion = resolveMotionId(motionRaw)
  return PATH_COMPOSITE_MOTIONS.has(motion) && pathHasTravel(path, stageRadius)
}

function samplePath(path: PresetKeyframes, t: number, fallback: Vec3): Vec3 {
  return interpolateKeyframes(toInterpKeyframes(path), t, 'position', fallback)
}

function compositeBounce(path: PresetKeyframes, params: MotionParams): PresetKeyframes {
  const sorted = [...path].sort((a, b) => a.time - b.time)
  const duration = sorted[sorted.length - 1].time
  if (duration <= 0) return path

  const height = params.height ?? 1.5
  const hops = Math.max(1, Math.round(params.hops ?? Math.max(2, duration / 0.45)))
  const decay = params.decay ?? DEFAULT_BOUNCE_DECAY
  const schedule = buildBounceHopSchedule(duration, height, hops, decay)
  const fallback = sorted[0].value
  const out: PresetKeyframes = []
  const samples = Math.max(64, sorted.length * 8)

  for (let i = 0; i <= samples; i++) {
    const t = (i / samples) * duration
    const base = samplePath(sorted, t, fallback)
    const hop = schedule.find((h) => t <= h.end) ?? schedule[schedule.length - 1]
    const span = Math.max(1e-6, hop.end - hop.start)
    const local = Math.min(1, Math.max(0, (t - hop.start) / span))
    const arc = 4 * local * (1 - local)
    out.push({ time: t, value: [base[0], base[1] + arc * hop.height, base[2]] })
  }
  return out
}

function compositeFloat(path: PresetKeyframes, params: MotionParams): PresetKeyframes {
  const sorted = [...path].sort((a, b) => a.time - b.time)
  const duration = sorted[sorted.length - 1].time
  if (duration <= 0) return path

  const amp = params.amplitude ?? 0.35
  const cycles = params.frequency ?? 1.5
  const fallback = sorted[0].value
  const out: PresetKeyframes = []
  const samples = Math.max(40, sorted.length * 4)

  for (let i = 0; i <= samples; i++) {
    const t = (i / samples) * duration
    const base = samplePath(sorted, t, fallback)
    const bob = Math.sin(t * Math.PI * 2 * cycles) * amp
    out.push({ time: t, value: [base[0], base[1] + bob, base[2]] })
  }
  return out
}

function compositeShake(path: PresetKeyframes, params: MotionParams): PresetKeyframes {
  const sorted = [...path].sort((a, b) => a.time - b.time)
  const duration = sorted[sorted.length - 1].time
  if (duration <= 0) return path

  const amp = params.amplitude ?? 0.08
  const cycles = params.frequency ?? 12
  const fallback = sorted[0].value
  const out: PresetKeyframes = []
  const samples = Math.max(40, sorted.length * 4)

  for (let i = 0; i <= samples; i++) {
    const t = (i / samples) * duration
    const base = samplePath(sorted, t, fallback)
    const decay = 1 - (t / duration) * 0.5
    const w = t * Math.PI * 2 * cycles
    out.push({
      time: t,
      value: [
        base[0] + Math.sin(w * 1.7) * amp * decay,
        base[1],
        base[2] + Math.cos(w) * amp * decay,
      ],
    })
  }
  return out
}

function compositePop(path: PresetKeyframes, params: MotionParams): PresetKeyframes {
  const sorted = [...path].sort((a, b) => a.time - b.time)
  const duration = sorted[sorted.length - 1].time
  if (duration <= 0) return path

  const h = params.height ?? 1.2
  const fallback = sorted[0].value
  const out: PresetKeyframes = []
  const samples = Math.max(32, sorted.length * 4)

  for (let i = 0; i <= samples; i++) {
    const t = (i / samples) * duration
    const base = samplePath(sorted, t, fallback)
    const alpha = t / duration
    const lift = alpha < 0.35 ? (alpha / 0.35) * h : h * (1 - (alpha - 0.35) / 0.65)
    out.push({ time: t, value: [base[0], base[1] + Math.max(0, lift), base[2]] })
  }
  return out
}

export function compositeMotionOntoPath(
  path: PresetKeyframes,
  motionRaw: string,
  params: MotionParams = {}
): PresetKeyframes {
  const motion = resolveMotionId(motionRaw)
  switch (motion) {
    case 'float':
      return compositeFloat(path, params)
    case 'shake':
      return compositeShake(path, params)
    case 'pop':
      return compositePop(path, params)
    case 'bounce':
    default:
      return compositeBounce(path, params)
  }
}

export function existingPositionPath(
  keyframes: Array<{ time: number; property: string; value: Vec3 }>
): PresetKeyframes {
  return keyframes
    .filter((k) => k.property === 'position')
    .sort((a, b) => a.time - b.time)
    .map((k) => ({ time: k.time, value: k.value }))
}
