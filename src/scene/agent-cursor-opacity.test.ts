import assert from 'node:assert/strict'
import test from 'node:test'
import { dampToward } from './opacity-damp.ts'

test('dampToward approaches the target without overshooting', () => {
  let opacity = 0
  for (let i = 0; i < 40; i++) opacity = dampToward(opacity, 1, 16.67, 320)
  assert.ok(opacity > 0.85)
  assert.ok(opacity < 1)
  opacity = dampToward(opacity, 1, 16.67, 320)
  assert.ok(opacity <= 1)
})

test('dampToward is frame-rate stable for the same elapsed time', () => {
  let at60 = 0
  for (let i = 0; i < 30; i++) at60 = dampToward(at60, 1, 1000 / 60, 320)

  let at30 = 0
  for (let i = 0; i < 15; i++) at30 = dampToward(at30, 1, 1000 / 30, 320)

  assert.ok(Math.abs(at60 - at30) < 0.02)
})

test('dampToward exits faster with a shorter tau (pending crossfade)', () => {
  let slow = 1
  let fast = 1
  for (let i = 0; i < 12; i++) {
    slow = dampToward(slow, 0, 16.67, 720)
    fast = dampToward(fast, 0, 16.67, 260)
  }
  assert.ok(fast < slow)
})
