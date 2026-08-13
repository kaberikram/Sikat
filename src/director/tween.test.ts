import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'

import { useEditorStore } from '../store.ts'
import {
  cancelTween,
  resetTweensForTests,
  retargetTween,
  startTween,
  tickTweens,
} from './tween.ts'

/**
 * Deterministic clock. Both `startTween` and `tickTweens` read
 * `performance.now()`, so stubbing it here is enough to drive time by hand.
 */
let clock = 0
const realNow = performance.now.bind(performance)

beforeEach(() => {
  clock = 1_000
  performance.now = () => clock
  resetTweensForTests()
  useEditorStore.getState().setExporting(false)
})

afterEach(() => {
  performance.now = realNow
  resetTweensForTests()
  useEditorStore.getState().setExporting(false)
})

const advance = (ms: number) => {
  clock += ms
}

/** A tween that records everything written to it. */
function recorder() {
  const writes: number[][] = []
  return { writes, set: (v: number[]) => writes.push(v) }
}

test('a tween does not advance until it is ticked', () => {
  // The XR bug in one assertion. The engine used to schedule its own
  // requestAnimationFrame, which the browser suspends for the whole of an
  // immersive session — so a spawn's 1%-scale entrance pop never came back up
  // and the prop stayed 2.8mm wide until the session ended.
  const r = recorder()
  startTween({ key: 'o:scale', from: [0.01], to: [1], durationSec: 1, easing: 'linear', set: r.set })
  advance(500)
  assert.deepEqual(r.writes, [], 'nothing should move without a tick')
  tickTweens()
  assert.equal(r.writes.length, 1)
  assert.ok(Math.abs(r.writes[0][0] - 0.505) < 1e-6)
})

test('ticking past the duration lands exactly on the target', () => {
  const r = recorder()
  startTween({ key: 'o:scale', from: [0], to: [2], durationSec: 0.5, easing: 'linear', set: r.set })
  advance(10_000)
  tickTweens()
  assert.deepEqual(r.writes.at(-1), [2])
  // …and the tween retires, so a later tick writes nothing more.
  const before = r.writes.length
  advance(100)
  tickTweens()
  assert.equal(r.writes.length, before)
})

test('a finished tween settles on the target, never past it', () => {
  const r = recorder()
  startTween({ key: 'o:pos', from: [0], to: [10], durationSec: 1, easing: 'easeOut', set: r.set })
  for (let i = 0; i < 12; i++) {
    advance(100)
    tickTweens()
  }
  assert.deepEqual(r.writes.at(-1), [10])
  assert.ok(r.writes.every((w) => w[0] <= 10 + 1e-9))
})

test('exporting holds a tween in place instead of advancing it', () => {
  const r = recorder()
  startTween({ key: 'o:pos', from: [0], to: [1], durationSec: 1, easing: 'linear', set: r.set })
  useEditorStore.getState().setExporting(true)
  advance(400)
  tickTweens()
  advance(400)
  tickTweens()
  assert.deepEqual(r.writes, [], 'the exporter owns the scene; tweens wait')

  // Released, the tween resumes from where it paused rather than jumping to
  // where wall-clock time would have carried it.
  useEditorStore.getState().setExporting(false)
  advance(500)
  tickTweens()
  assert.equal(r.writes.length, 1)
  assert.ok(r.writes[0][0] < 0.75, `resumed too far: ${r.writes[0][0]}`)
})

test('a second tween on the same key replaces the first', () => {
  const first = recorder()
  const second = recorder()
  startTween({ key: 'o:pos', from: [0], to: [1], durationSec: 1, easing: 'linear', set: first.set })
  startTween({ key: 'o:pos', from: [0], to: [5], durationSec: 1, easing: 'linear', set: second.set })
  advance(500)
  tickTweens()
  assert.deepEqual(first.writes, [], 'the superseded tween must stop writing')
  assert.equal(second.writes.length, 1)
})

test('cancelling writes the current interpolated value and stops', () => {
  const r = recorder()
  startTween({ key: 'o:pos', from: [0], to: [10], durationSec: 1, easing: 'linear', set: r.set })
  advance(300)
  const current = cancelTween('o:pos')
  assert.ok(current && Math.abs(current[0] - 3) < 1e-6)
  assert.deepEqual(r.writes.at(-1), current)
  const before = r.writes.length
  advance(500)
  tickTweens()
  assert.equal(r.writes.length, before, 'a cancelled tween is gone')
})

test('cancelling something that is not running is harmless', () => {
  assert.equal(cancelTween('nothing:here'), null)
})

test('retargeting continues from current progress', () => {
  const r = recorder()
  startTween({ key: 'o:pos', from: [0], to: [10], durationSec: 1, easing: 'linear', set: r.set })
  advance(500)
  assert.equal(retargetTween('o:pos', [0], 1), true)
  // Halfway to 10 is 5; the new leg runs 5 → 0, so halfway again is ~2.5.
  advance(500)
  tickTweens()
  assert.ok(Math.abs(r.writes.at(-1)![0] - 2.5) < 1e-6, `got ${r.writes.at(-1)}`)
})

test('retargeting something that is not running reports false', () => {
  assert.equal(retargetTween('nothing:here', [1]), false)
})

test('ticking with nothing active is a no-op', () => {
  // The render loop calls this every frame forever; the idle path has to be free.
  assert.doesNotThrow(() => tickTweens())
})

test('a tween started long after the last one is not fast-forwarded', () => {
  // `lastNow` is only used for the exporter hold, but a stale value carried
  // across an idle stretch would silently skew the first frame of the hold.
  const first = recorder()
  startTween({ key: 'a', from: [0], to: [1], durationSec: 0.1, easing: 'linear', set: first.set })
  advance(200)
  tickTweens()
  assert.deepEqual(first.writes.at(-1), [1])

  advance(60_000) // long idle, nothing active
  const second = recorder()
  startTween({ key: 'b', from: [0], to: [1], durationSec: 1, easing: 'linear', set: second.set })
  useEditorStore.getState().setExporting(true)
  advance(100)
  tickTweens()
  useEditorStore.getState().setExporting(false)
  advance(500)
  tickTweens()
  // Held for 100ms then ran for 500ms — about halfway, not carried by the idle.
  assert.ok(Math.abs(second.writes.at(-1)![0] - 0.5) < 1e-6, `got ${second.writes.at(-1)}`)
})
