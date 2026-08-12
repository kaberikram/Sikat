/**
 * One owner per surface, enforced.
 *
 * These pin the two resolution rules that stop ambient subsystems from
 * overwriting each other. Both replace last-writer-wins semantics that produced
 * bugs you could only see in a full session, never in a module test.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveAccent, resolveRoomState, type AccentOwner } from './ambient-policy.ts'

// ---- room state: listening and working are independent facts ----

test('the room shows nothing when nothing is happening', () => {
  assert.equal(resolveRoomState(false, false), 'idle')
})

test('each fact shows on its own', () => {
  assert.equal(resolveRoomState(true, false), 'listening')
  assert.equal(resolveRoomState(false, true), 'working')
})

test('listening outranks working', () => {
  // The bug: hold A to correct something while the crew is still applying the
  // previous command, and the instant its packet landed the ring stopped
  // showing that it could hear you — mid sentence. Being heard is the more
  // urgent thing to know.
  assert.equal(resolveRoomState(true, true), 'listening')
})

test('work finishing under an open mic leaves the mic showing', () => {
  const listening = true
  assert.equal(resolveRoomState(listening, true), 'listening')
  assert.equal(resolveRoomState(listening, false), 'listening')
})

test('releasing the mic reveals work still in flight', () => {
  assert.equal(resolveRoomState(false, true), 'working')
})

// ---- room accent: one owner, by priority ----

const claim = (color: string, weight = 1) => ({ color, weight })

test('no claims means no accent', () => {
  assert.equal(resolveAccent({}), null)
})

test('a lone claim wins whoever it is', () => {
  assert.deepEqual(resolveAccent({ proposal: claim('#f00') }), claim('#f00'))
  assert.deepEqual(resolveAccent({ entry: claim('#0f0') }), claim('#0f0'))
})

test('the entry cinematic outranks a proposal', () => {
  // Entry used to write the surface directly every frame for ~3.7s, so a
  // proposal arriving mid-cinematic was overwritten on the next frame anyway —
  // but by accident, and entry's release then cleared the proposal's colour.
  // Now it is a stated priority, and releasing entry hands the surface back.
  const both: Partial<Record<AccentOwner, { color: string; weight: number }>> = {
    proposal: claim('#f00'),
    entry: claim('#0f0'),
  }
  assert.deepEqual(resolveAccent(both), claim('#0f0'))

  delete both.entry
  assert.deepEqual(resolveAccent(both), claim('#f00'), 'proposal survives entry ending')
})

test('releasing the winner falls back rather than going blank', () => {
  const claims: Partial<Record<AccentOwner, { color: string; weight: number }>> = {
    proposal: claim('#f00', 0.45),
    entry: claim('#0f0', 0.8),
  }
  delete claims.entry
  const after = resolveAccent(claims)
  assert.equal(after?.color, '#f00')
  assert.equal(after?.weight, 0.45, 'the survivor keeps its own weight')
})

test('releasing every claim clears the accent', () => {
  const claims: Partial<Record<AccentOwner, { color: string; weight: number }>> = {
    entry: claim('#0f0'),
  }
  delete claims.entry
  assert.equal(resolveAccent(claims), null)
})

test('an explicitly undefined claim is not a claim', () => {
  assert.equal(resolveAccent({ entry: undefined, proposal: undefined }), null)
  assert.deepEqual(resolveAccent({ entry: undefined, proposal: claim('#f00') }), claim('#f00'))
})
