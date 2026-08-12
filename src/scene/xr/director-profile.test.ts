import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isProfileConfident,
  median,
  migrateProfile,
  preferredStandoff,
  pushSample,
  type DirectorProfile,
} from './director-profile.ts'

const profile = (patch: Partial<DirectorProfile> = {}): DirectorProfile => ({
  version: 1,
  sessions: 0,
  standoffs: [],
  ...patch,
})

test('median handles both parities and ignores input order', () => {
  assert.equal(median([]), null)
  assert.equal(median([2]), 2)
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
})

test('median resists a single wild sample', () => {
  // One session where they wandered off shouldn't move the habit.
  assert.equal(median([1.8, 1.9, 2.0, 40]), 1.95)
})

test('samples keep only the recent tail', () => {
  let s: number[] = []
  for (let i = 0; i < 30; i++) s = pushSample(s, i)
  assert.equal(s.length, 12)
  assert.equal(s[s.length - 1], 29, 'newest kept')
  assert.equal(s[0], 18, 'oldest dropped')
})

test('non-finite samples are refused rather than stored', () => {
  assert.deepEqual(pushSample([1], NaN), [1])
  assert.deepEqual(pushSample([1], Infinity), [1])
})

test('a missing or unusable record migrates to an empty profile', () => {
  for (const bad of [null, undefined, 42, 'nope', []]) {
    const p = migrateProfile(bad)
    assert.equal(p.sessions, 0)
    assert.deepEqual(p.standoffs, [])
  }
})

test('a record from another version is discarded, not trusted', () => {
  const p = migrateProfile({ version: 99, sessions: 500, standoffs: [9, 9, 9] })
  assert.equal(p.sessions, 0)
  assert.deepEqual(p.standoffs, [])
})

test('migration strips junk out of otherwise valid arrays', () => {
  const p = migrateProfile({
    version: 1,
    sessions: 3,
    standoffs: [1.9, 'two', null, 2.1, NaN],
  })
  assert.equal(p.sessions, 3)
  assert.deepEqual(p.standoffs, [1.9, 2.1])
})

test('migration truncates an over-long stored tail', () => {
  const p = migrateProfile({
    version: 1,
    sessions: 3,
    standoffs: Array.from({ length: 40 }, (_, i) => i),
  })
  assert.equal(p.standoffs.length, 12)
  assert.equal(p.standoffs[p.standoffs.length - 1], 39)
})

test('a negative or fractional session count is repaired', () => {
  assert.equal(migrateProfile({ version: 1, sessions: -5 }).sessions, 0)
  assert.equal(migrateProfile({ version: 1, sessions: 3.7 }).sessions, 3)
})

test('one session is not yet a habit', () => {
  assert.equal(isProfileConfident(profile({ sessions: 1 })), false)
  assert.equal(isProfileConfident(profile({ sessions: 2 })), true)
})

test('standoff falls back to the default until there is history', () => {
  assert.equal(preferredStandoff(profile(), 1.9, [1.2, 3]), 1.9)
  // Enough sessions but no samples recorded yet.
  assert.equal(preferredStandoff(profile({ sessions: 5 }), 1.9, [1.2, 3]), 1.9)
})

test('standoff blends toward the habit rather than snapping to it', () => {
  const p = profile({ sessions: 5, standoffs: [2.6, 2.6, 2.6] })
  const got = preferredStandoff(p, 1.9, [1.2, 3])
  assert.ok(got > 1.9 && got < 2.6, `expected a blend, got ${got}`)
  assert.equal(got, 1.9 * 0.4 + 2.6 * 0.6)
})

test('standoff stays inside the comfortable range whatever the history says', () => {
  const tooClose = profile({ sessions: 5, standoffs: [0.1, 0.1, 0.1] })
  assert.equal(preferredStandoff(tooClose, 1.9, [1.2, 3]), 1.2)

  const tooFar = profile({ sessions: 5, standoffs: [50, 50, 50] })
  assert.equal(preferredStandoff(tooFar, 1.9, [1.2, 3]), 3)
})
