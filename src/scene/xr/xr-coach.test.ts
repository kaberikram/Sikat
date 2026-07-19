import assert from 'node:assert/strict'
import test from 'node:test'

import {
  currentCoachHint,
  noteCoachAction,
  resetXrCoachForTest,
  startXrCoach,
} from './xr-coach.ts'

// Node has no localStorage — the module treats that as "not seen" via its
// guarded access, so each start() below runs a fresh coach.

test('coach waits for the entry cinematic, then rotates all three lines', () => {
  resetXrCoachForTest()
  startXrCoach(0)
  assert.equal(currentCoachHint(1000), null, 'silent during the cinematic')
  assert.equal(currentCoachHint(5300), 'TRIGGER · FILM')
  assert.equal(currentCoachHint(5200 + 4100), 'HOLD A · TALK')
  assert.equal(currentCoachHint(5200 + 8100), 'say “crew, set the stage”')
  // Second cycle wraps around.
  assert.equal(currentCoachHint(5200 + 12100), 'TRIGGER · FILM')
})

test('coach ends after two full cycles', () => {
  resetXrCoachForTest()
  startXrCoach(0)
  assert.equal(currentCoachHint(5200 + 6 * 4000 + 100), null)
})

test('performing an action retires its line', () => {
  resetXrCoachForTest()
  startXrCoach(0)
  noteCoachAction('rec')
  assert.equal(currentCoachHint(5300), 'HOLD A · TALK', 'rec line skipped')
  noteCoachAction('talk')
  assert.equal(currentCoachHint(5300), 'say “crew, set the stage”')
  noteCoachAction('stage')
  assert.equal(currentCoachHint(5300), null, 'all learned — coach over')
})
