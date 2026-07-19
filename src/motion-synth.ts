/**
 * Parametric motion synthesis — turns motion id + params into keyframe tracks.
 */
import {
  buildBouncePositionKeyframes,
  buildOrbitPositionKeyframes,
  buildTurnaroundRotationKeyframes,
  DEFAULT_BOUNCE_DECAY,
  type PresetKeyframes,
} from './animation-presets.ts'
import { ease } from './easing.ts'
import type { Easing } from './director/protocol'

export type Vec3 = [number, number, number]

export interface MotionParams {
  height?: number
  hops?: number
  decay?: number
  amplitude?: number
  frequency?: number
  radius?: number
  turns?: number
  axis?: number
  easing?: Easing
  span?: number
  /** 0 = local orbit, 1 = orbit around stage center */
  pivot?: number
  waypoints?: number
  seed?: number
  /** Y scale at max squash (0–1) */
  flat?: number
}

export interface StageContext {
  center: Vec3
  radius: number
}

const DEFAULT_STAGE_RADIUS = 1

function hashVec3(v: Vec3): number {
  return Math.abs(v[0] * 12.9898 + v[1] * 78.233 + v[2] * 37.719)
}

function seededRandom(seed: number): number {
  const x = Math.sin(seed * 9999.123) * 43758.5453
  return x - Math.floor(x)
}

function clampToStageDisc(point: Vec3, stage: StageContext): Vec3 {
  const [cx, , cz] = stage.center
  const dx = point[0] - cx
  const dz = point[2] - cz
  const dist = Math.hypot(dx, dz)
  const maxR = stage.radius * 0.88
  if (dist <= maxR) return point
  const k = maxR / dist
  return [cx + dx * k, point[1], cz + dz * k]
}

function withStageDefaults(params: MotionParams, stage: StageContext, motion: MotionId): MotionParams {
  const r = stage.radius || DEFAULT_STAGE_RADIUS
  const out = { ...params }
  if (out.span == null && ['drift', 'arc', 'zigzag', 'launch', 'swing'].includes(motion)) {
    out.span = r * 0.45
  }
  if (out.amplitude == null) {
    if (motion === 'sway') out.amplitude = r * 0.12
    else if (motion === 'float') out.amplitude = r * 0.035
    else if (motion === 'wander') out.amplitude = r * 0.06
  }
  if (out.radius == null && ['figure8', 'spiral', 'orbit'].includes(motion)) {
    out.radius = r * (motion === 'orbit' && out.pivot === 1 ? 0.55 : 0.22)
  }
  if (out.height == null && ['drop', 'rise', 'launch', 'arc', 'pop'].includes(motion)) {
    out.height = r * 0.12
  }
  return out
}

const SAMPLES = 40

function sampleTrack(
  duration: number,
  fn: (t: number) => Vec3,
  count = SAMPLES
): PresetKeyframes {
  const out: PresetKeyframes = []
  for (let i = 0; i <= count; i++) {
    const alpha = i / count
    out.push({ time: alpha * duration, value: fn(alpha) })
  }
  return out
}

function withEasing(fn: (t: number) => Vec3, easing: Easing, duration: number): PresetKeyframes {
  return sampleTrack(duration, (t) => fn(ease(t, easing)))
}

function buildFloat(base: Vec3, duration: number, p: MotionParams): PresetKeyframes {
  const amp = p.amplitude ?? 0.35
  const cycles = p.frequency ?? 1.5
  const [x, y, z] = base
  return sampleTrack(duration, (t) => [x, y + Math.sin(t * Math.PI * 2 * cycles) * amp, z])
}

function buildDrop(base: Vec3, duration: number, p: MotionParams): PresetKeyframes {
  const h = p.height ?? 3
  const soft = (p.decay ?? 1) <= 0.35
  const [x, y, z] = base
  return sampleTrack(duration, (t) => {
    const fall = t * t
    const height = h * (1 - fall)
    const settle =
      soft && t > 0.88 ? Math.sin(((t - 0.88) / 0.12) * Math.PI) * 0.04 * h : 0
    return [x, y + height + settle, z]
  })
}

function buildRise(base: Vec3, duration: number, p: MotionParams): PresetKeyframes {
  const h = p.height ?? 2
  const [x, y, z] = base
  return withEasing((t) => [x, y + t * h, z], p.easing ?? 'easeOut', duration)
}

function buildPulse(base: Vec3, duration: number, p: MotionParams): PresetKeyframes {
  const amp = p.amplitude ?? 0.25
  const cycles = p.frequency ?? 2
  const [x, y, z] = base
  const s = 1 + amp
  return sampleTrack(duration, (t) => {
    const k = 1 + Math.sin(t * Math.PI * 2 * cycles) * amp
    return [(x * k) / s, (y * k) / s, (z * k) / s]
  })
}

function buildSway(base: Vec3, duration: number, p: MotionParams): PresetKeyframes {
  const amp = p.amplitude ?? 0.8
  const cycles = p.frequency ?? 1
  const [x, y, z] = base
  return sampleTrack(duration, (t) => [x + Math.sin(t * Math.PI * 2 * cycles) * amp, y, z])
}

function buildSpin(baseRot: Vec3, duration: number, p: MotionParams): PresetKeyframes {
  const turns = p.turns ?? 1
  const axis = Math.min(2, Math.max(0, Math.round(p.axis ?? 1)))
  const [rx, ry, rz] = baseRot
  return sampleTrack(duration, (t) => {
    const rot: Vec3 = [rx, ry, rz]
    rot[axis] = rot[axis] + t * Math.PI * 2 * turns
    return rot
  })
}

function buildWobble(baseRot: Vec3, duration: number, p: MotionParams): PresetKeyframes {
  const amp = p.amplitude ?? 0.18
  const cycles = p.frequency ?? 3
  const [rx, ry, rz] = baseRot
  return sampleTrack(duration, (t) => [rx, ry, rz + Math.sin(t * Math.PI * 2 * cycles) * amp])
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

function lerpAt(a: Vec3, b: Vec3, ta: number, tb: number, t: number): Vec3 {
  if (Math.abs(tb - ta) < 1e-6) return a
  return lerp3(a, b, (t - ta) / (tb - ta))
}

/** Centripetal Catmull-Rom sample between p1→p2 (t in 0..1). */
function catmullSample(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const t0 = 0
  const t1 = t0 + Math.sqrt(Math.max(dist3(p0, p1), 1e-4))
  const t2 = t1 + Math.sqrt(Math.max(dist3(p1, p2), 1e-4))
  const t3 = t2 + Math.sqrt(Math.max(dist3(p2, p3), 1e-4))
  const u = t1 + (t2 - t1) * t
  const a1 = lerpAt(p0, p1, t0, t1, u)
  const a2 = lerpAt(p1, p2, t1, t2, u)
  const a3 = lerpAt(p2, p3, t2, t3, u)
  const b1 = lerpAt(a1, a2, t0, t2, u)
  const b2 = lerpAt(a2, a3, t1, t3, u)
  return lerpAt(b1, b2, t1, t2, u)
}

/** Soft roam: gentle heading changes, curved through waypoints (no zig-zag). */
function buildWander(base: Vec3, duration: number, p: MotionParams, stage: StageContext): PresetKeyframes {
  const margin = 0.82
  const maxR = stage.radius * margin
  const [cx, , cz] = stage.center
  const [x, y, z] = base
  const seed = p.seed ?? hashVec3(base)
  const n = Math.max(3, Math.min(6, Math.round(p.waypoints ?? 4)))
  const bob = p.amplitude ?? maxR * 0.04

  const wps: Vec3[] = [clampToStageDisc([x, y, z], stage)]
  let relX = x - cx
  let relZ = z - cz
  let angle = seededRandom(seed) * Math.PI * 2

  for (let i = 0; i < n; i++) {
    // Soft turns — avoid sharp corner waypoints that read as robotic.
    angle += (0.25 + seededRandom(seed + i * 7.1) * 0.7) * (seededRandom(seed + i * 3.3) > 0.45 ? 1 : -1)
    const step = maxR * (0.22 + seededRandom(seed + i * 11.9) * 0.28)
    relX += Math.cos(angle) * step
    relZ += Math.sin(angle) * step
    const dist = Math.hypot(relX, relZ)
    if (dist > maxR) {
      const k = maxR / dist
      relX *= k
      relZ *= k
      angle += Math.PI * 0.35
    }
    const vy = y + Math.sin(i * 0.9 + seed) * bob * 0.55
    wps.push(clampToStageDisc([cx + relX, vy, cz + relZ], stage))
  }

  const segments = wps.length - 1
  const samplesPerSeg = Math.max(8, Math.ceil((SAMPLES * 1.5) / segments))
  const out: PresetKeyframes = []
  for (let s = 0; s < segments; s++) {
    const p0 = wps[Math.max(0, s - 1)]
    const p1 = wps[s]
    const p2 = wps[s + 1]
    const p3 = wps[Math.min(wps.length - 1, s + 2)]
    for (let j = 0; j < samplesPerSeg; j++) {
      const local = j / samplesPerSeg
      const globalT = (s + ease(local, 'easeInOut')) / segments
      const point = catmullSample(p0, p1, p2, p3, local)
      const floatY = Math.sin(globalT * Math.PI * 2 * 1.25) * bob * 0.35
      out.push({
        time: globalT * duration,
        value: clampToStageDisc([point[0], point[1] + floatY, point[2]], stage),
      })
    }
  }
  out.push({ time: duration, value: wps[wps.length - 1] })
  return out
}

function buildDrift(base: Vec3, duration: number, p: MotionParams, stage: StageContext): PresetKeyframes {
  const span = p.span ?? stage.radius * 0.45
  const amp = p.amplitude ?? stage.radius * 0.04
  const [x, y, z] = base
  const seed = p.seed ?? hashVec3(base)
  const angle = seededRandom(seed) * Math.PI * 2
  const dx = Math.cos(angle) * span
  const dz = Math.sin(angle) * span
  return sampleTrack(duration, (t) =>
    clampToStageDisc([x + t * dx, y + Math.sin(t * Math.PI * 2) * amp, z + t * dz], stage)
  )
}

function buildArc(base: Vec3, duration: number, p: MotionParams, stage: StageContext): PresetKeyframes {
  const span = p.span ?? stage.radius * 0.45
  const h = p.height ?? stage.radius * 0.12
  const [x, y, z] = base
  const seed = p.seed ?? hashVec3(base)
  const angle = seededRandom(seed + 3.7) * Math.PI * 2
  const dx = Math.cos(angle) * span
  const dz = Math.sin(angle) * span
  return sampleTrack(duration, (t) =>
    clampToStageDisc([x + t * dx, y + Math.sin(t * Math.PI) * h, z + t * dz], stage)
  )
}

function buildPop(base: Vec3, duration: number, p: MotionParams): PresetKeyframes {
  const h = p.height ?? 1.2
  const [x, y, z] = base
  return withEasing(
    (t) => {
      const lift = t < 0.35 ? (t / 0.35) * h : h * (1 - (t - 0.35) / 0.65)
      return [x, y + Math.max(0, lift), z]
    },
    'easeOut',
    duration
  )
}

function buildShake(base: Vec3, duration: number, p: MotionParams): PresetKeyframes {
  const amp = p.amplitude ?? 0.08
  const cycles = p.frequency ?? 12
  const [x, y, z] = base
  return sampleTrack(duration, (t) => {
    const decay = 1 - t * 0.6
    const w = t * Math.PI * 2 * cycles
    return [x + Math.sin(w * 1.7) * amp * decay, y, z + Math.cos(w) * amp * decay]
  })
}

function buildFigure8(base: Vec3, duration: number, p: MotionParams): PresetKeyframes {
  const r = p.radius ?? 1.2
  const [x, y, z] = base
  return sampleTrack(duration, (t) => {
    const theta = t * Math.PI * 2
    return [x + Math.sin(theta) * r, y, z + Math.sin(theta * 2) * 0.5 * r]
  })
}

export type MotionId =
  | 'bounce'
  | 'float'
  | 'drop'
  | 'rise'
  | 'pulse'
  | 'sway'
  | 'spin'
  | 'orbit'
  | 'turnaround'
  | 'wobble'
  | 'drift'
  | 'arc'
  | 'pop'
  | 'shake'
  | 'figure8'
  | 'zigzag'
  | 'spiral'
  | 'launch'
  | 'swing'
  | 'wander'
  | 'squash'

function buildSquash(base: Vec3, duration: number, p: MotionParams): PresetKeyframes {
  const flat = p.flat ?? 0.35
  const stretch = 1 + (1 - flat) * 0.35
  const [sx, sy, sz] = base
  const squashAt = 0.22
  const hold = 0.08
  const recover = 0.45
  return [
    { time: 0, value: [sx, sy, sz] },
    { time: duration * squashAt, value: [sx * stretch, sy * flat, sz * stretch] },
    { time: duration * (squashAt + hold), value: [sx * stretch, sy * flat, sz * stretch] },
    { time: duration * recover, value: [sx, sy, sz] },
    { time: duration, value: [sx, sy, sz] },
  ]
}

function buildZigzag(base: Vec3, duration: number, p: MotionParams, stage: StageContext): PresetKeyframes {
  const span = p.span ?? stage.radius * 0.45
  const amp = p.amplitude ?? stage.radius * 0.08
  const cycles = p.frequency ?? 3
  const [x, y, z] = base
  const seed = p.seed ?? hashVec3(base)
  const angle = seededRandom(seed + 9.1) * Math.PI * 2
  const dx = Math.cos(angle) * span
  const dz = Math.sin(angle) * span
  // Soft sine weave — not square-wave left/right snaps.
  return sampleTrack(duration, (t) =>
    clampToStageDisc(
      [
        x + t * dx + Math.sin(t * Math.PI * 2 * cycles) * amp * Math.cos(angle + Math.PI / 2),
        y + Math.sin(t * Math.PI * 2 * cycles * 0.5) * amp * 0.25,
        z + t * dz + Math.sin(t * Math.PI * 2 * cycles) * amp * Math.sin(angle + Math.PI / 2),
      ],
      stage
    )
  )
}

function buildSpiral(base: Vec3, duration: number, p: MotionParams): PresetKeyframes {
  const r0 = p.radius ?? 0.3
  const r1 = p.amplitude ?? 1.2
  const [x, y, z] = base
  return sampleTrack(duration, (t) => {
    const theta = t * Math.PI * 4
    const r = r0 + t * r1
    return [x + Math.sin(theta) * r, y + t * (p.height ?? 0.5), z + Math.cos(theta) * r]
  })
}

function buildLaunch(base: Vec3, duration: number, p: MotionParams, stage: StageContext): PresetKeyframes {
  const h = p.height ?? stage.radius * 0.15
  const span = p.span ?? stage.radius * 0.45
  const [x, y, z] = base
  const seed = p.seed ?? hashVec3(base)
  const angle = seededRandom(seed + 2.1) * Math.PI * 2
  const dx = Math.cos(angle) * span
  const dz = Math.sin(angle) * span
  return sampleTrack(duration, (t) => {
    const up = t < 0.35 ? ease(t / 0.35, 'easeOut') * h : h * (1 - ease((t - 0.35) / 0.65, 'easeIn'))
    return clampToStageDisc([x + t * dx, y + up, z + t * dz], stage)
  })
}

function buildSwing(base: Vec3, duration: number, p: MotionParams): PresetKeyframes {
  const amp = p.amplitude ?? 1.2
  const [x, y, z] = base
  return sampleTrack(duration, (t) => {
    const theta = t * Math.PI
    return [x + Math.sin(theta) * amp, y - (1 - Math.cos(theta)) * 0.2, z + Math.cos(theta) * amp * 0.3]
  })
}

const MOTION_ALIASES: Record<string, MotionId> = {
  bounce: 'bounce',
  bouncing: 'bounce',
  hop: 'bounce',
  float: 'float',
  floating: 'float',
  hover: 'float',
  drift: 'drift',
  drop: 'drop',
  fall: 'drop',
  rise: 'rise',
  lift: 'rise',
  pulse: 'pulse',
  breathe: 'pulse',
  sway: 'sway',
  wiggle: 'sway',
  spin: 'spin',
  spinning: 'spin',
  turnaround: 'turnaround',
  orbit: 'orbit',
  circle: 'orbit',
  wobble: 'wobble',
  arc: 'arc',
  throw: 'arc',
  pop: 'pop',
  reveal: 'pop',
  shake: 'shake',
  vibrate: 'shake',
  figure8: 'figure8',
  zigzag: 'zigzag',
  spiral: 'spiral',
  launch: 'launch',
  swing: 'swing',
  swoop: 'arc',
  wander: 'wander',
  roam: 'wander',
  explore: 'wander',
  free: 'wander',
  squashed: 'squash',
  squish: 'squash',
  flatten: 'squash',
  pancake: 'squash',
}

export function resolveMotionId(raw: string): MotionId {
  const key = raw.trim().toLowerCase()
  if (key in MOTION_ALIASES) return MOTION_ALIASES[key]
  if (key === 'turn around' || key === '360') return 'turnaround'
  return key as MotionId
}

/** Short, motion-specific clip length — not the full 10s timeline. */
export function defaultMotionDuration(motionRaw: string, params: MotionParams = {}): number {
  const motion = resolveMotionId(motionRaw)
  switch (motion) {
    case 'drop':
      return Math.min(2.8, 0.75 + (params.height ?? 3) * 0.22)
    case 'bounce':
      return 0.55 + (params.hops ?? 2) * 0.42
    case 'pop':
      return 0.55
    case 'rise':
      return 0.8 + (params.height ?? 2) * 0.18
    case 'shake':
      return 0.65
    case 'arc':
      return 1.4
    case 'float':
      return 2.5 / (params.frequency ?? 1)
    case 'sway':
      return 2 / (params.frequency ?? 1)
    case 'pulse':
      return 1.2 / (params.frequency ?? 1)
    case 'spin':
    case 'turnaround':
      return 1.5 * (params.turns ?? 1)
    case 'orbit':
    case 'figure8':
      return 3
    case 'wander':
      return 4 + (params.waypoints ?? 5) * 0.35
    case 'drift':
      return 2.5
    case 'zigzag':
    case 'launch':
      return 1.6
    case 'spiral':
      return 2.8
    case 'swing':
      return 1.8
    case 'wobble':
      return 1.2
    case 'squash':
      return 0.9
    default:
      return 2
  }
}

export interface MotionTrack {
  property: 'position' | 'rotation' | 'scale'
  keyframes: PresetKeyframes
}

export function motionKeyframes(
  basePosition: Vec3,
  baseRotation: Vec3,
  baseScale: Vec3,
  motionRaw: string,
  durationSec: number,
  params: MotionParams = {},
  stage: StageContext = { center: [0, 0, 0], radius: DEFAULT_STAGE_RADIUS }
): MotionTrack {
  const motion = resolveMotionId(motionRaw)
  const p = withStageDefaults(params, stage, motion)

  switch (motion) {
    case 'float':
      return { property: 'position', keyframes: buildFloat(basePosition, durationSec, p) }
    case 'drop':
      return { property: 'position', keyframes: buildDrop(basePosition, durationSec, p) }
    case 'rise':
      return { property: 'position', keyframes: buildRise(basePosition, durationSec, p) }
    case 'sway':
      return { property: 'position', keyframes: buildSway(basePosition, durationSec, p) }
    case 'drift':
      return { property: 'position', keyframes: buildDrift(basePosition, durationSec, p, stage) }
    case 'wander':
      return { property: 'position', keyframes: buildWander(basePosition, durationSec, p, stage) }
    case 'arc':
      return { property: 'position', keyframes: buildArc(basePosition, durationSec, p, stage) }
    case 'pop':
      return { property: 'position', keyframes: buildPop(basePosition, durationSec, p) }
    case 'shake':
      return { property: 'position', keyframes: buildShake(basePosition, durationSec, p) }
    case 'figure8':
      return {
        property: 'position',
        keyframes: buildFigure8(basePosition, durationSec, p),
      }
    case 'zigzag':
      return { property: 'position', keyframes: buildZigzag(basePosition, durationSec, p, stage) }
    case 'spiral':
      return {
        property: 'position',
        keyframes: buildSpiral(basePosition, durationSec, p),
      }
    case 'launch':
      return { property: 'position', keyframes: buildLaunch(basePosition, durationSec, p, stage) }
    case 'swing':
      return { property: 'position', keyframes: buildSwing(basePosition, durationSec, p) }
    case 'pulse':
      return { property: 'scale', keyframes: buildPulse(baseScale, durationSec, p) }
    case 'squash':
      return { property: 'scale', keyframes: buildSquash(baseScale, durationSec, p) }
    case 'spin':
    case 'turnaround':
      return {
        property: 'rotation',
        keyframes:
          motion === 'turnaround' && p.turns == null
            ? buildTurnaroundRotationKeyframes(baseRotation, durationSec)
            : buildSpin(baseRotation, durationSec, { ...p, turns: p.turns ?? 1 }),
      }
    case 'orbit': {
      const stageOrbit = p.pivot === 1
      const center = stageOrbit ? stage.center : basePosition
      const orbitR =
        p.radius ??
        (stageOrbit
          ? Math.max(1, Math.hypot(basePosition[0] - stage.center[0], basePosition[2] - stage.center[2]))
          : stage.radius * 0.22)
      return {
        property: 'position',
        keyframes: buildOrbitPositionKeyframes(basePosition, durationSec, center, orbitR),
      }
    }
    case 'wobble':
      return { property: 'rotation', keyframes: buildWobble(baseRotation, durationSec, p) }
    case 'bounce':
    default:
      return {
        property: 'position',
        keyframes: buildBouncePositionKeyframes(
          basePosition,
          durationSec,
          p.height ?? Math.max(0.25, stage.radius * 0.45),
          p.hops ?? 2,
          p.decay ?? DEFAULT_BOUNCE_DECAY,
          p.seed ?? 0
        ),
      }
  }
}
