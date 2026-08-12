import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyCursorHome,
  idleDecision,
  watchdogExpired,
  CURSOR_WATCHDOG_MS,
} from './cursor-lifecycle.ts'

// ---- where a cursor belongs ----

test('a resolved subject puts the cursor on the object', () => {
  const home = classifyCursorHome([1, 2, 3], true)
  assert.equal(home.kind, 'object')
  assert.deepEqual(home.kind === 'object' && home.position, [1, 2, 3])
})

test('scene-wide work belongs at the crew station', () => {
  // No subject named — lights, FX, playback. The station is a real place.
  assert.equal(classifyCursorHome(null, false).kind, 'station')
})

test('a named subject that did not resolve gets no cursor at all', () => {
  // This is the "appears somewhere random" bug: the old code fell back to the
  // station, sending a crew member to a spot unrelated to the command.
  assert.equal(classifyCursorHome(null, true).kind, 'none')
})

test('a resolved position wins even when the subject flag disagrees', () => {
  // Defensive: if we have a real place, use it regardless of bookkeeping.
  assert.equal(classifyCursorHome([0, 0, 0], false).kind, 'object')
})

test('the origin is a legitimate position, not a missing one', () => {
  // [0,0,0] is falsy-adjacent in a lot of vector code; make sure it survives.
  const home = classifyCursorHome([0, 0, 0], true)
  assert.equal(home.kind, 'object')
})

// ---- the watchdog ----

test('a cursor that has never worked is not swept', () => {
  // 0 means "no beat recorded", not "beat at time zero".
  assert.equal(watchdogExpired(0, 10 ** 9), false)
})

test('a fresh beat keeps the cursor', () => {
  assert.equal(watchdogExpired(1000, 1000 + CURSOR_WATCHDOG_MS - 1), false)
})

test('silence past the budget retires the cursor', () => {
  assert.equal(watchdogExpired(1000, 1000 + CURSOR_WATCHDOG_MS), true)
  assert.equal(watchdogExpired(1000, 1000 + CURSOR_WATCHDOG_MS * 3), true)
})

test('the budget outlasts the gap the waiting spinner exists to cover', () => {
  // markAgentWaiting exists because a grammar batch can finish seconds before
  // late LLM motion arrives. If the watchdog were tighter than that gap it
  // would cut cursors off mid-command.
  assert.ok(CURSOR_WATCHDOG_MS > 10_000, `too tight: ${CURSOR_WATCHDOG_MS}`)
})

// ---- retirement ----

test('an idle agent with nothing running fades now', () => {
  assert.equal(
    idleDecision({ phase: 'intent', busy: false, hasFadeTimer: false }),
    'fade-now'
  )
})

test('an already-scheduled fade is left alone', () => {
  assert.equal(
    idleDecision({ phase: 'intent', busy: false, hasFadeTimer: true }),
    'already-scheduled'
  )
})

test('a busy agent defers rather than dropping the fade', () => {
  // The drain owns the choreography, but the fade is still owed — this is the
  // distinction the stuck-cursor bug turned on.
  assert.equal(
    idleDecision({ phase: 'flying', busy: true, hasFadeTimer: false }),
    'defer'
  )
})

test('mid-choreography phases defer so a settle is not cut short', () => {
  for (const phase of ['settling', 'done']) {
    assert.equal(
      idleDecision({ phase, busy: false, hasFadeTimer: false }),
      'defer',
      `phase ${phase}`
    )
  }
})

test('busy wins over an existing fade timer', () => {
  // If work restarted, the pending fade should not be treated as sufficient.
  assert.equal(
    idleDecision({ phase: 'working', busy: true, hasFadeTimer: true }),
    'defer'
  )
})

test('an unknown phase still resolves to a decision', () => {
  // No input should ever leave a cursor with nothing scheduled.
  for (const phase of [undefined, 'idle', 'nonsense']) {
    const d = idleDecision({ phase, busy: false, hasFadeTimer: false })
    assert.ok(d === 'fade-now' || d === 'defer', `phase ${phase} → ${d}`)
  }
})
