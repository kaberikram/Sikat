import assert from 'node:assert/strict'
import test from 'node:test'

import {
  admitToQueue,
  COMMAND_BUDGET_MS,
  linkExpired,
  linkLabel,
  linkMode,
  LIVENESS_TIMEOUT_MS,
  pruneQueue,
  QUEUE_MAX_AGE_MS,
  QUEUE_MAX_ENTRIES,
} from './link-health.ts'

// ---- dead-socket detection ----

test('a link that has heard nothing for the budget is dead', () => {
  assert.equal(linkExpired(1_000, 1_000 + LIVENESS_TIMEOUT_MS), true)
})

test('a link that just heard something is alive', () => {
  assert.equal(linkExpired(1_000, 1_000 + LIVENESS_TIMEOUT_MS - 1), false)
})

test('a connection that has never received a frame is not yet dead', () => {
  // The window between `new WebSocket()` and the first frame. Treating this as
  // death would close every socket before it finished opening.
  assert.equal(linkExpired(0, 999_999), false)
})

test('the liveness budget outlasts a slow command', () => {
  // A command in flight sends nothing back until the first packet. If the
  // liveness window were the shorter of the two, the reconnect would kill the
  // very command it was waiting on.
  assert.ok(
    LIVENESS_TIMEOUT_MS > COMMAND_BUDGET_MS,
    'liveness timeout must outlast the command budget'
  )
})

// ---- held commands ----

const at = (queuedAt: number) => ({ queuedAt })

test('a held command replays while it is still fresh', () => {
  const queue = admitToQueue([], at(1_000), 1_000)
  assert.deepEqual(pruneQueue(queue, 1_000 + QUEUE_MAX_AGE_MS - 1), [at(1_000)])
})

test('a held command past its age is dropped rather than replayed', () => {
  // Replaying a twenty-second-old intention is the set acting on something the
  // director has already moved on from.
  const queue = admitToQueue([], at(1_000), 1_000)
  assert.deepEqual(pruneQueue(queue, 1_000 + QUEUE_MAX_AGE_MS), [])
})

test('the backlog is capped, and it is the oldest that goes', () => {
  let queue: { queuedAt: number }[] = []
  for (let i = 0; i < QUEUE_MAX_ENTRIES + 3; i++) queue = admitToQueue(queue, at(i), 0)
  assert.equal(queue.length, QUEUE_MAX_ENTRIES)
  // The most recent thing said is the one still being waited on.
  assert.equal(queue[queue.length - 1].queuedAt, QUEUE_MAX_ENTRIES + 2)
  assert.equal(queue[0].queuedAt, 3)
})

test('admitting prunes stale entries on the way in', () => {
  const stale = admitToQueue([], at(0), 0)
  const fresh = admitToQueue(stale, at(QUEUE_MAX_AGE_MS), QUEUE_MAX_AGE_MS)
  assert.deepEqual(fresh, [at(QUEUE_MAX_AGE_MS)])
})

// ---- what the pod says ----

test('a link that dropped reads as reconnecting, not closed', () => {
  // The bug this covers: `closed` rendered raw, so a live reconnect looked
  // exactly like a permanent failure.
  const mode = linkMode({ status: 'closed', configured: true, everConnected: true, attempts: 1 })
  assert.equal(mode, 'reconnecting')
  assert.equal(linkLabel(mode), 'reconnecting')
})

test('reconnecting names what it is holding', () => {
  assert.equal(linkLabel('reconnecting', 2), 'reconnecting · 2 held')
})

test('a server that never answered is a calm local-crew mode', () => {
  assert.equal(
    linkMode({ status: 'closed', configured: true, everConnected: false, attempts: 1 }),
    'local-crew'
  )
})

test('no configured server is distinct from a lost link', () => {
  // Same raw `closed` status, opposite meanings: one is a build without a
  // server URL, the other is a server that just vanished.
  assert.equal(
    linkMode({ status: 'closed', configured: false, everConnected: false, attempts: 3 }),
    'unconfigured'
  )
  assert.equal(linkLabel('unconfigured'), 'no crew server')
})

test('an open link reports open whatever its history', () => {
  const base = { status: 'open' as const, configured: true }
  assert.equal(linkMode({ ...base, everConnected: true, attempts: 4 }), 'open')
  assert.equal(linkMode({ ...base, everConnected: false, attempts: 0 }), 'open')
})

test('a socket quietly retrying a server that never answered stays calm', () => {
  // Regression: the retry loop cycles connecting -> closed every second or two.
  // Reporting each tick made the calm local-crew state flicker into something
  // that reads as broken, which is the opposite of what offline should feel like.
  assert.equal(
    linkMode({ status: 'connecting', configured: true, everConnected: false, attempts: 2 }),
    'local-crew'
  )
})

test('the genuine first attempt still reads as connecting', () => {
  assert.equal(
    linkMode({ status: 'connecting', configured: true, everConnected: false, attempts: 0 }),
    'connecting'
  )
})
