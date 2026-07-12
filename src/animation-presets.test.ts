import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildBounceHopSchedule,
  buildBouncePositionKeyframes,
  buildBounceScaleKeyframes,
  DEFAULT_BOUNCE_DECAY,
} from './animation-presets.ts'
import { interpolateKeyframes } from './keyframe-interpolation.ts'

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
  const keys = buildBounceScaleKeyframes([1, 1, 1], 2, 2, DEFAULT_BOUNCE_DECAY, 0.55)
  const minY = Math.min(...keys.map((k) => k.value[1]))
  const maxX = Math.max(...keys.map((k) => k.value[0]))
  assert.ok(minY < 0.9)
  assert.ok(maxX > 1.05)
  assert.deepEqual(keys[0].value, [1, 1, 1])
  assert.deepEqual(keys[keys.length - 1].value, [1, 1, 1])
})

test('bounce apex lands after 50% of each hop (gravity hang)', () => {
  const duration = 2
  const hops = 2
  const decay = DEFAULT_BOUNCE_DECAY
  const schedule = buildBounceHopSchedule(duration, 1.5, hops, decay)
  const keys = buildBouncePositionKeyframes([0, 1, 0], duration, 1.5, hops, decay, 0)
  for (const hop of schedule) {
    const span = hop.end - hop.start
    const inHop = keys.filter((k) => k.time >= hop.start && k.time <= hop.end + 1e-9)
    assert.ok(inHop.length > 0)
    let best = inHop[0]
    for (const k of inHop) {
      if (k.value[1] > best.value[1]) best = k
    }
    const local = (best.time - hop.start) / span
    assert.ok(local > 0.5, `apex at ${local} should be after mid-hop`)
  }
})

test('bounce spline does not dip below floor', () => {
  const baseY = 1
  const keys = buildBouncePositionKeyframes([0, baseY, 0], 2, 1.5, 3, DEFAULT_BOUNCE_DECAY, 7)
  const interp = keys.map((k) => ({
    time: k.time,
    property: 'position' as const,
    value: k.value,
  }))
  let minY = Infinity
  for (let i = 0; i <= 1000; i++) {
    const t = (i / 1000) * 2
    const v = interpolateKeyframes(interp, t, 'position', [0, baseY, 0])
    minY = Math.min(minY, v[1])
  }
  assert.ok(minY >= baseY - 0.02, `minY=${minY}`)
})

test('squash minima align with position contact times', () => {
  const duration = 2
  const hops = 2
  const decay = DEFAULT_BOUNCE_DECAY
  const schedule = buildBounceHopSchedule(duration, 1, hops, decay)
  const scaleKeys = buildBounceScaleKeyframes([1, 1, 1], duration, hops, decay, 0.55)
  for (const hop of schedule) {
    const contact = hop.end
    const span = hop.end - hop.start
    const window = scaleKeys.filter((k) => Math.abs(k.time - contact) <= span * 0.04 + 1e-6)
    assert.ok(window.length > 0, `no squash keys near contact ${contact}`)
    const minY = Math.min(...window.map((k) => k.value[1]))
    assert.ok(minY < 0.95, `expected impact squash near ${contact}, got minY=${minY}`)
  }
})
