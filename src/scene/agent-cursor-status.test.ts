import assert from 'node:assert/strict'
import test from 'node:test'
import { getCursorStatusVisibility } from './agent-cursor-status.ts'

test('shows only the spinner while intent is still being resolved', () => {
  assert.deepEqual(
    getCursorStatusVisibility({
      active: true,
      phase: 'intent',
      hasConfirmedNote: true,
    }),
    { showCheck: false, showNote: false, showSpinner: true }
  )
})

test('shows spinner when active with no confirmed note', () => {
  assert.deepEqual(
    getCursorStatusVisibility({
      active: true,
      phase: 'intent',
      hasConfirmedNote: false,
    }),
    { showCheck: false, showNote: false, showSpinner: true }
  )
})

test('shows the confirmed feedback note once the action starts', () => {
  assert.deepEqual(
    getCursorStatusVisibility({
      active: true,
      phase: 'flying',
      hasConfirmedNote: true,
    }),
    { showCheck: false, showNote: true, showSpinner: false }
  )
})

test('keeps the feedback note visible while applying', () => {
  assert.deepEqual(
    getCursorStatusVisibility({
      active: true,
      phase: 'working',
      hasConfirmedNote: true,
    }),
    { showCheck: false, showNote: true, showSpinner: false }
  )
})

test('shows only the check mark after commit', () => {
  assert.deepEqual(
    getCursorStatusVisibility({
      active: true,
      phase: 'settling',
      hasConfirmedNote: true,
    }),
    { showCheck: true, showNote: false, showSpinner: false }
  )
})

test('done phase keeps the check and never shows a spinner', () => {
  assert.deepEqual(
    getCursorStatusVisibility({
      active: true,
      phase: 'done',
      hasConfirmedNote: false,
    }),
    { showCheck: true, showNote: false, showSpinner: false }
  )
})

test('announce/intent keeps spinner even with a confirmed preview note', () => {
  // Calm choreography holds the named spinner during CURSOR_ANNOUNCE_MS
  // before travel — status chrome must stay spinner-only in that beat.
  assert.deepEqual(
    getCursorStatusVisibility({
      active: true,
      phase: 'intent',
      hasConfirmedNote: true,
    }),
    { showCheck: false, showNote: false, showSpinner: true }
  )
})

test('shows no status chrome after cancellation or idle', () => {
  assert.deepEqual(
    getCursorStatusVisibility({
      active: false,
      phase: 'idle',
      hasConfirmedNote: false,
    }),
    { showCheck: false, showNote: false, showSpinner: false }
  )
})
