import assert from 'node:assert/strict'
import test from 'node:test'

import { sampleAmbient, type AmbientInput } from './ambient-sense.ts'

const base: AmbientInput = {
  headSpeed: 0,
  gripTurnRate: 0,
  dwellMs: 0,
  aimSwitches: 0,
  sinceCommandMs: 0,
  sinceTakeMs: 0,
  hasAim: false,
}

const at = (patch: Partial<AmbientInput>) => sampleAmbient({ ...base, ...patch })

test('a director standing still reads as fully still', () => {
  assert.equal(at({}).stillness, 1)
})

test('walking and swinging both cost stillness, and the worse one wins', () => {
  const walking = at({ headSpeed: 0.55 })
  const swinging = at({ gripTurnRate: 1.4 })
  assert.equal(walking.stillness, 0)
  assert.equal(swinging.stillness, 0)

  // Whichever motion is stronger sets the floor — a slow walk while whipping
  // the camcorder around is not "half still".
  const both = at({ headSpeed: 0.11, gripTurnRate: 1.4 })
  assert.equal(both.stillness, 0)
})

test('stillness scales smoothly rather than latching', () => {
  // Half of MOVING_SPEED (0.55) should read as roughly half still.
  const half = at({ headSpeed: 0.275 })
  assert.ok(half.stillness > 0.4 && half.stillness < 0.6, `got ${half.stillness}`)
})

test('focus needs both an aim and time on it', () => {
  assert.equal(at({ hasAim: false, dwellMs: 5000 }).focus, 0)
  assert.equal(at({ hasAim: true, dwellMs: 0 }).focus, 0)

  const settled = at({ hasAim: true, dwellMs: 900 })
  assert.equal(settled.focus, 1)
})

test('focus is discounted while the director is moving', () => {
  const still = at({ hasAim: true, dwellMs: 900 })
  const moving = at({ hasAim: true, dwellMs: 900, headSpeed: 0.55 })
  assert.ok(moving.focus < still.focus)
  // Even at a dead run, a long dwell still counts for something.
  assert.ok(moving.focus > 0)
})

test('dwell passes through untouched for callers that want the raw number', () => {
  assert.equal(at({ hasAim: true, dwellMs: 1234 }).dwellMs, 1234)
})

test('someone working steadily is not hesitating', () => {
  // Just spoke, locked onto one object, standing still.
  const working = at({ hasAim: true, dwellMs: 1500, sinceCommandMs: 500 })
  assert.equal(working.hesitation, 0)
})

test('quiet alone is not hesitation — a long take is quiet too', () => {
  // Silent for a while, but settled on one subject and holding steady.
  const filming = at({ hasAim: true, dwellMs: 4000, sinceCommandMs: 12_000 })
  assert.ok(filming.hesitation < 0.05, `got ${filming.hesitation}`)
})

test('quiet plus sweeping across objects reads as hesitation', () => {
  const lost = at({
    hasAim: true,
    dwellMs: 100,
    aimSwitches: 4,
    sinceCommandMs: 12_000,
    headSpeed: 0.2,
  })
  assert.ok(lost.hesitation > 0.7, `got ${lost.hesitation}`)
})

test('hesitation builds with silence rather than switching on', () => {
  const shape = { hasAim: true, dwellMs: 100, aimSwitches: 4, headSpeed: 0.2 }
  const early = at({ ...shape, sinceCommandMs: 3000 })
  const later = at({ ...shape, sinceCommandMs: 9000 })
  assert.ok(early.hesitation < later.hesitation)
  assert.ok(early.hesitation > 0)
})

test('every signal stays inside its range under absurd input', () => {
  const wild = at({
    headSpeed: 99,
    gripTurnRate: 99,
    dwellMs: 10 ** 7,
    aimSwitches: 500,
    sinceCommandMs: 10 ** 7,
    hasAim: true,
  })
  for (const key of ['stillness', 'focus', 'hesitation'] as const) {
    assert.ok(wild[key] >= 0 && wild[key] <= 1, `${key} out of range: ${wild[key]}`)
  }
})

test('clocks pass straight through', () => {
  const s = at({ sinceCommandMs: 4200, sinceTakeMs: 88_000 })
  assert.equal(s.sinceCommandMs, 4200)
  assert.equal(s.sinceTakeMs, 88_000)
})
