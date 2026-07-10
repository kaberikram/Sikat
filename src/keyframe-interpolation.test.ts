import assert from 'node:assert/strict'
import test from 'node:test'

import { interpolateKeyframes } from './keyframe-interpolation.ts'

const positionTrack = [
  { time: 0, property: 'position', value: [0, 0, 0] as [number, number, number] },
  { time: 1, property: 'position', value: [1, 0, 0] as [number, number, number] },
  { time: 2, property: 'position', value: [1, 1, 0] as [number, number, number] },
  { time: 3, property: 'position', value: [2, 1, 0] as [number, number, number] },
]

test('position tracks pass through authored keys', () => {
  assert.deepEqual(interpolateKeyframes(positionTrack, 1, 'position', [9, 9, 9]), [1, 0, 0])
  assert.deepEqual(interpolateKeyframes(positionTrack, 2, 'position', [9, 9, 9]), [1, 1, 0])
})

test('position tracks curve smoothly between sparse keys', () => {
  const midpoint = interpolateKeyframes(positionTrack, 1.5, 'position', [0, 0, 0])
  assert(midpoint[0] > 0.9 && midpoint[0] < 1.1)
  assert(midpoint[1] > 0 && midpoint[1] < 1)
})

test('scale remains linear to avoid overshoot', () => {
  const keys = [
    { time: 0, property: 'scale', value: [1, 1, 1] as [number, number, number] },
    { time: 1, property: 'scale', value: [2, 2, 2] as [number, number, number] },
  ]
  assert.deepEqual(interpolateKeyframes(keys, 0.5, 'scale', [1, 1, 1]), [1.5, 1.5, 1.5])
})
