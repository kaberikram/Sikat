import assert from 'node:assert/strict'
import test from 'node:test'

import {
  coachPacing,
  currentCoachHint,
  noteCoachAction,
  resetXrCoachForTest,
  setCoachHesitation,
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

test('hesitation buys more time on each line', () => {
  const calm = coachPacing(0, 1)
  const lost = coachPacing(1, 1)
  assert.ok(lost.lineMs > calm.lineMs)
  // Patience is bounded — a stuck director does not get an infinite line.
  assert.ok(lost.lineMs <= calm.lineMs * 2)
})

test('a low reading alone does not cut the coach short', () => {
  // At the first tracked frame nobody has hesitated, because nobody has done
  // anything. Confidence has to be demonstrated first.
  assert.equal(coachPacing(0, 0).cycles, 2)
  assert.equal(coachPacing(0, 1).cycles, 1)
})

test('a hesitating director keeps the full repeat even after learning one control', () => {
  assert.equal(coachPacing(0.9, 2).cycles, 2)
})

test('a confident director is let go after one cycle', () => {
  resetXrCoachForTest()
  startXrCoach(0)
  // Used the trigger already, and reading settled.
  noteCoachAction('rec')
  setCoachHesitation(0)
  // Two lines left, one cycle each — done after two slots.
  assert.equal(currentCoachHint(5300), 'HOLD A · TALK')
  assert.equal(currentCoachHint(5200 + 4100), 'say “crew, set the stage”')
  assert.equal(currentCoachHint(5200 + 8100), null, 'let go early')
})

test('a hesitating director still gets both cycles', () => {
  resetXrCoachForTest()
  startXrCoach(0)
  noteCoachAction('rec')
  setCoachHesitation(1)
  // Lines now hold for 1.8x as long, so the second cycle is still running
  // where the confident director was already finished.
  assert.ok(currentCoachHint(5200 + 8100) !== null, 'still coaching')
})
