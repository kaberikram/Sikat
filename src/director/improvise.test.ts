import assert from 'node:assert/strict'
import test from 'node:test'

import { beatsToSpecs, choreograph, IMPROVISED_HERO } from './improvise.ts'
import { isCreativeBrief } from './local-grammar.ts'

const SET_DAY = [
  { id: '1', name: 'PEDESTAL' },
  { id: '2', name: 'SNEAKER_ONE' },
  { id: '3', name: 'SET_SIGN' },
]

// ---- what counts as an open-ended brief ----

test('the phrasings people actually use are recognised', () => {
  for (const raw of [
    'do crazy motion graphics, surprise me',
    'surprise me',
    'go wild',
    'make it interesting',
    'something cool',
    'choreograph a take',
    'wow me',
    'blow my mind',
    'I trust you',
    'go off',
    'make it insane',
    'neon Tokyo',
    'make this feel like a music video intro',
    'go crazy',
    'goes crazy',
    'animation goes crazy',
  ]) {
    assert.ok(isCreativeBrief(raw), raw)
  }
})

test('a specific direction is not a creative brief', () => {
  // These have real grammar matches and must keep going down that path.
  for (const raw of [
    'add a red box',
    'make the sphere bounce',
    'golden hour',
    'move the box up 2',
    'cut',
  ]) {
    assert.equal(isCreativeBrief(raw), false, raw)
  }
})

// ---- choreography ----

test('every object on set gets a beat', () => {
  const beats = choreograph(SET_DAY, 'surprise me')
  assert.equal(beats.length, 3)
  assert.deepEqual(beats.map((b) => b.target), ['PEDESTAL', 'SNEAKER_ONE', 'SET_SIGN'])
  assert.ok(beats.every((b) => !b.spawn))
})

test('an empty set still produces a shot', () => {
  // "surprise me" on a bare stage should not be a no-op.
  const beats = choreograph([], 'surprise me')
  assert.equal(beats.length, 1)
  assert.equal(beats[0].target, IMPROVISED_HERO)
  assert.equal(beats[0].spawn, true)
})

test('a take is never empty, whatever the set', () => {
  for (const objs of [[], SET_DAY, SET_DAY.slice(0, 1)]) {
    assert.ok(choreograph(objs, 'go wild').length > 0)
  }
})

test('objects are staggered so it reads as choreography', () => {
  const beats = choreograph(SET_DAY, 'surprise me')
  const delays = beats.map((b) => b.delaySec)
  assert.deepEqual([...delays].sort((a, b) => a - b), delays, 'delays increase')
  assert.equal(delays[0], 0, 'something moves immediately')
  assert.ok(new Set(delays).size === delays.length, 'no two start together')
})

test('a busy set is capped so it stays a shot rather than noise', () => {
  const crowd = Array.from({ length: 12 }, (_, i) => ({ id: `${i}`, name: `OBJ_${i}` }))
  assert.equal(choreograph(crowd, 'go wild').length, 4)
})

test('neighbouring objects get different paths', () => {
  const beats = choreograph(SET_DAY, 'surprise me')
  const first = JSON.stringify(beats[0].keyframes)
  assert.ok(beats.some((b) => JSON.stringify(b.keyframes) !== first), 'not all the same path')
})

// ---- determinism ----

test('the same brief replays identically', () => {
  assert.deepEqual(choreograph(SET_DAY, 'surprise me'), choreograph(SET_DAY, 'surprise me'))
})

test('different briefs look different', () => {
  const a = choreograph(SET_DAY, 'surprise me')
  const b = choreograph(SET_DAY, 'go wild')
  assert.notDeepEqual(a.map((x) => x.keyframes), b.map((x) => x.keyframes))
})

// ---- packets ----

test('a populated set authors keys without spawning anything', () => {
  const specs = beatsToSpecs(choreograph(SET_DAY, 'surprise me'))
  assert.equal(specs.filter((s) => s.body.command === 'SPAWN_OBJECT').length, 0)
  assert.equal(specs.filter((s) => s.body.command === 'SET_KEYFRAMES').length, 3)
  assert.equal(specs.filter((s) => s.body.command === 'ANIMATE_OBJECT').length, 0)
})

test('an empty set spawns the subject before keyframing it', () => {
  const specs = beatsToSpecs(choreograph([], 'surprise me'))
  assert.equal(specs[0].body.command, 'SPAWN_OBJECT')
  assert.equal(specs[1].body.command, 'SET_KEYFRAMES')
})

test('every keyframe target is provided by the same set of specs', () => {
  // The invariant the server-side bug broke: never animate a name that nothing
  // on set has and nothing here creates.
  for (const objs of [[], SET_DAY]) {
    const specs = beatsToSpecs(choreograph(objs, 'surprise me'))
    const available = new Set(objs.map((o) => o.name))
    for (const s of specs) {
      const payload = s.body.payload as { name?: string; target?: { name?: string } }
      if (s.body.command === 'SPAWN_OBJECT' && payload.name) available.add(payload.name)
      if (s.body.command === 'SET_KEYFRAMES') {
        assert.ok(available.has(payload.target?.name ?? ''), `${payload.target?.name} unprovided`)
      }
    }
  }
})

test('no transport packet — local specs only address the crew agents', () => {
  const specs = beatsToSpecs(choreograph(SET_DAY, 'surprise me'))
  assert.ok(specs.every((s) => s.body.command !== 'PLAYBACK'))
  assert.ok(specs.every((s) => s.agent === 'AssetAnimator'))
})
