import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addVec,
  isNearZeroDelta,
  translateObjectPose,
  vecDelta,
} from './stage-relocate.ts'

test('vecDelta is to − from', () => {
  assert.deepEqual(vecDelta([1, 2, 3], [4, 6, 9]), [3, 4, 6])
})

test('isNearZeroDelta ignores floating dust', () => {
  assert.equal(isNearZeroDelta([0, 0, 0]), true)
  assert.equal(isNearZeroDelta([1e-12, 0, 0]), true)
  assert.equal(isNearZeroDelta([0.01, 0, 0]), false)
})

test('addVec shifts each axis', () => {
  assert.deepEqual(addVec([1, 2, 3], [0.5, -1, 2]), [1.5, 1, 5])
})

test('translateObjectPose moves base position and position keyframes only', () => {
  const delta: [number, number, number] = [1, 0, -2]
  const { position, keyframes } = translateObjectPose(
    [0, 0, 0],
    [
      { time: 0, property: 'position', value: [0, 1, 0] },
      { time: 1, property: 'rotation', value: [0, 1, 0] },
      { time: 2, property: 'position', value: [2, 1, 3] },
      { time: 3, property: 'scale', value: [1, 1, 1] },
    ],
    delta
  )
  assert.deepEqual(position, [1, 0, -2])
  assert.deepEqual(keyframes[0].value, [1, 1, -2])
  assert.deepEqual(keyframes[1].value, [0, 1, 0], 'rotation untouched')
  assert.deepEqual(keyframes[2].value, [3, 1, 1])
  assert.deepEqual(keyframes[3].value, [1, 1, 1], 'scale untouched')
})
