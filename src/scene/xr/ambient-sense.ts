/**
 * Ambient sense — a cheap read of what the director is actually doing.
 *
 * Ambient intelligence is supposed to anticipate needs and adapt to behaviour,
 * and it can't do either without noticing anything. This is the noticing: a few
 * scalars, updated per frame, describing whether you're settled or roaming, how
 * long you've been looking at one thing, how well it's framed, and how long
 * since you last said or shot anything.
 *
 * Nothing here decides anything on its own. It feeds the room's idle tone, the
 * coach's patience, and the moment a proposal is allowed to surface — the point
 * being that the set should never interrupt someone mid-move.
 *
 * The scoring is a pure function (`sampleAmbient`) so it can be unit tested;
 * `updateAmbientSense` is the thin stateful shell that feeds it poses.
 *
 * Cost: a handful of scalar EMAs and two vector deltas on module-scope scratch
 * vectors. Nothing is allocated on the frame path.
 *
 * These signals stay on the client. Sending them to the crew's observer would
 * mean a wire-protocol change, and the contract has one normative copy
 * (docs/DirectorAI/03_PRD_Architecture/Command_Protocol.md) that has to move in
 * lockstep with schema.py and protocol.ts. Everything below earns its keep
 * without touching it.
 */
import * as THREE from 'three'

export interface AmbientInput {
  /** Head linear speed, m/s. */
  headSpeed: number
  /** Grip angular speed, rad/s. */
  gripTurnRate: number
  /** How long the aim has rested on the current object, ms (0 when aiming at nothing). */
  dwellMs: number
  /** How many distinct objects the aim has crossed in the last few seconds. */
  aimSwitches: number
  /** Milliseconds since the last spoken command. */
  sinceCommandMs: number
  /** Milliseconds since the last take ended. */
  sinceTakeMs: number
  /** Whether anything is currently aimed at. */
  hasAim: boolean
}

export interface AmbientSignals {
  /** 0..1 — 1 means the director is standing still and holding steady. */
  stillness: number
  /** How long the aim has rested on one object, ms. */
  dwellMs: number
  /** 0..1 — settled attention on one subject rather than sweeping the room. */
  focus: number
  /** 0..1 — looks like someone who isn't sure what to do next. */
  hesitation: number
  sinceCommandMs: number
  sinceTakeMs: number
}

/** Above this the director is clearly moving, not composing. */
const MOVING_SPEED = 0.55
/** Above this the camcorder is being swung rather than aimed. */
const SWINGING_RATE = 1.4
/** Dwell past this reads as real attention rather than the ray passing over. */
const FOCUS_DWELL_MS = 900
/** Silence past this, while still looking around, starts reading as hesitation. */
const IDLE_COMMAND_MS = 12_000
/** Crossing this many objects in the sample window is sweeping, not choosing. */
const SWEEP_SWITCHES = 4

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/**
 * Score a moment. Pure — same input, same output, no clocks and no globals.
 */
export function sampleAmbient(input: AmbientInput): AmbientSignals {
  const moving = clamp01(input.headSpeed / MOVING_SPEED)
  const swinging = clamp01(input.gripTurnRate / SWINGING_RATE)
  const stillness = clamp01(1 - Math.max(moving, swinging))

  const dwell = clamp01(input.dwellMs / FOCUS_DWELL_MS)
  const focus = input.hasAim ? clamp01(dwell * (0.4 + 0.6 * stillness)) : 0

  // Hesitation is the shape of someone looking without acting: quiet for a
  // while, eyes moving over several things, nothing settled. Any one of those
  // alone is normal, so they multiply rather than add.
  const quiet = clamp01(input.sinceCommandMs / IDLE_COMMAND_MS)
  const sweeping = clamp01(input.aimSwitches / SWEEP_SWITCHES)
  const unsettled = 1 - focus
  const hesitation = clamp01(quiet * Math.max(sweeping, unsettled * 0.7))

  return {
    stillness,
    dwellMs: input.dwellMs,
    focus,
    hesitation,
    sinceCommandMs: input.sinceCommandMs,
    sinceTakeMs: input.sinceTakeMs,
  }
}

// ---- stateful shell ----

/** Window over which aim switches are counted. */
const SWITCH_WINDOW_MS = 4000
/** EMA smoothing for the raw speeds — raw per-frame deltas are far too jittery. */
const SPEED_SMOOTH = 6

let headSpeed = 0
let gripTurnRate = 0
let dwellSince = 0
let currentAim: string | null = null
let lastCommandAt = 0
let lastTakeAt = 0

const switchTimes: number[] = []

const prevHeadPos = new THREE.Vector3()
const headPos = new THREE.Vector3()
const prevGripQuat = new THREE.Quaternion()
const gripQuat = new THREE.Quaternion()
let hasPrev = false

let signals: AmbientSignals = {
  stillness: 1,
  dwellMs: 0,
  focus: 0,
  hesitation: 0,
  sinceCommandMs: 0,
  sinceTakeMs: 0,
}

export function getAmbientSignals(): AmbientSignals {
  return signals
}

/** Call when a command is actually submitted — resets the "quiet" clock. */
export function noteAmbientCommand(nowMs: number): void {
  lastCommandAt = nowMs
}

/** Call when a take ends. */
export function noteAmbientTake(nowMs: number): void {
  lastTakeAt = nowMs
}

export function updateAmbientSense(
  nowMs: number,
  delta: number,
  head: THREE.Object3D,
  grip: THREE.Object3D,
  aimedId: string | null
): void {
  if (lastCommandAt === 0) lastCommandAt = nowMs
  if (lastTakeAt === 0) lastTakeAt = nowMs

  head.getWorldPosition(headPos)
  grip.getWorldQuaternion(gripQuat)

  if (hasPrev && delta > 0) {
    const linear = headPos.distanceTo(prevHeadPos) / delta
    // angleTo is the shortest rotation between the two orientations.
    const angular = prevGripQuat.angleTo(gripQuat) / delta
    const k = Math.min(1, delta * SPEED_SMOOTH)
    headSpeed += (linear - headSpeed) * k
    gripTurnRate += (angular - gripTurnRate) * k
  }
  prevHeadPos.copy(headPos)
  prevGripQuat.copy(gripQuat)
  hasPrev = true

  if (aimedId !== currentAim) {
    currentAim = aimedId
    dwellSince = aimedId ? nowMs : 0
    if (aimedId) switchTimes.push(nowMs)
  }
  while (switchTimes.length > 0 && nowMs - switchTimes[0] > SWITCH_WINDOW_MS) switchTimes.shift()

  signals = sampleAmbient({
    headSpeed,
    gripTurnRate,
    dwellMs: dwellSince ? nowMs - dwellSince : 0,
    aimSwitches: switchTimes.length,
    sinceCommandMs: nowMs - lastCommandAt,
    sinceTakeMs: nowMs - lastTakeAt,
    hasAim: aimedId !== null,
  })
}

/** True when the set may speak up without cutting across something in progress. */
export function isGoodMomentToPropose(): boolean {
  return signals.stillness > 0.6 && signals.sinceCommandMs > 3000
}

export function resetAmbientSense(): void {
  headSpeed = 0
  gripTurnRate = 0
  dwellSince = 0
  currentAim = null
  lastCommandAt = 0
  lastTakeAt = 0
  switchTimes.length = 0
  hasPrev = false
  signals = {
    stillness: 1,
    dwellMs: 0,
    focus: 0,
    hesitation: 0,
    sinceCommandMs: 0,
    sinceTakeMs: 0,
  }
}
