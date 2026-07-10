import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildBounceHopSchedule,
  buildBouncePositionKeyframes,
  buildBounceScaleKeyframes,
} from './animation-presets.ts'

test('later hops are shorter under gravity (duration ∝ √height)', () => {
  const schedule = buildBounceHopSchedule(3, 1.5, 3, 0.5)
  assert.equal(schedule.length, 3)
  const spans = schedule.map((h) => h.end - h.start)
  assert.ok(spans[0] > spans[1])
  assert.ok(spans[1] > spans[2])
  assert.ok(Math.abs(schedule[schedule.length - 1].end - 3) < 1e-6)
})

test('bounce position peaks diminish and land near floor', () => {
  const keys = buildBouncePositionKeyframes([0, 1, 0], 2, 1.5, 2, 0.5, 0)
  const peaks = keys.filter((k) => k.value[1] > 1.05).map((k) => k.value[1])
  assert.ok(peaks.length >= 2)
  const max1 = Math.max(...peaks.slice(0, Math.ceil(peaks.length / 2)))
  const max2 = Math.max(...peaks.slice(Math.ceil(peaks.length / 2)))
  assert.ok(max1 > max2)
  assert.deepEqual(keys[keys.length - 1].value[1], 1)
})

test('bounce scale includes impact squash below rest Y', () => {
  const keys = buildBounceScaleKeyframes([1, 1, 1], 2, 2, 0.55, 0.55)
  const minY = Math.min(...keys.map((k) => k.value[1]))
  const maxX = Math.max(...keys.map((k) => k.value[0]))
  assert.ok(minY < 0.9)
  assert.ok(maxX > 1.05)
  assert.deepEqual(keys[0].value, [1, 1, 1])
  assert.deepEqual(keys[keys.length - 1].value, [1, 1, 1])
})
