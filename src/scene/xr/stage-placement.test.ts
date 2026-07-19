import assert from 'node:assert/strict'
import test from 'node:test'

import {
  computeStagePose,
  flattenForward,
  isHeadPoseValid,
  shouldReplaceStage,
  STAGE_STANDOFF_M,
  REPLACE_THRESHOLD_M,
} from './stage-placement.ts'

test('flattenForward projects onto the floor plane', () => {
  assert.deepEqual(flattenForward([0, 0, -1]), [0, 0, -1])
  const tilted = flattenForward([0, -0.7, -0.7])
  assert.ok(tilted)
  assert.equal(tilted[1], 0)
  assert.ok(Math.abs(Math.hypot(tilted[0], tilted[2]) - 1) < 1e-9, 'normalized')
})

test('looking straight down falls back instead of placing underfoot', () => {
  assert.equal(flattenForward([0, -1, 0]), null)
  const pose = computeStagePose([1, 1.6, 2], [0.01, -0.99, 0])
  // Fallback forward is -Z: stage lands ahead on -Z, never at the feet.
  assert.deepEqual(pose.position, [1, 0, 2 - STAGE_STANDOFF_M])
})

test('stage lands standoff meters ahead at floor level', () => {
  const pose = computeStagePose([0, 1.6, 0], [0, 0, -1])
  assert.deepEqual(pose.position, [0, 0, -STAGE_STANDOFF_M])

  // Pitched-down gaze still places ahead at the full standoff distance.
  const pitched = computeStagePose([2, 1.6, 3], [0.7, -0.5, -0.7])
  assert.equal(pitched.position[1], 0)
  const d = Math.hypot(pitched.position[0] - 2, pitched.position[2] - 3)
  assert.ok(Math.abs(d - STAGE_STANDOFF_M) < 1e-9)
})

test('isHeadPoseValid rejects the untracked identity pose and absurd heights', () => {
  assert.equal(isHeadPoseValid([0, 0, 0]), false)
  assert.equal(isHeadPoseValid([0.5, 0.2, 0.1]), false, 'below the sane band')
  assert.equal(isHeadPoseValid([0.5, 3.2, 0.1]), false, 'above the sane band')
  assert.equal(isHeadPoseValid([0.5, 1.6, 0.1]), true)
})

test('shouldReplaceStage only fires after a real move', () => {
  const head: [number, number, number] = [0, 1.6, 0]
  const forward: [number, number, number] = [0, 0, -1]
  const placed = computeStagePose(head, forward).position
  assert.equal(shouldReplaceStage(head, forward, placed), false, 'same spot — no teleport')
  assert.equal(
    shouldReplaceStage([REPLACE_THRESHOLD_M + 0.1, 1.6, 0], forward, placed),
    true,
    'moved past the threshold'
  )
  assert.equal(
    shouldReplaceStage([0.3, 1.6, 0], forward, placed),
    false,
    'small shuffle stays put'
  )
})
