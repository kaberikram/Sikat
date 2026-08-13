import assert from 'node:assert/strict'
import test from 'node:test'

import { bestMatch, primitiveForName, scoreMatch, tokenize } from './target-match.ts'

const SET_DAY = [
  { id: '1', name: 'PEDESTAL' },
  { id: '2', name: 'SNEAKER_ONE' },
  { id: '3', name: 'SET_SIGN' },
]

// ---- the reported failure ----

test('HERO_SPHERE finds a sphere that is actually on set', () => {
  // The exact case from the log: the crew named a hero sphere, the set had a
  // spawned one under a generated name, and the old one-directional `includes`
  // could not connect them.
  const hit = bestMatch('HERO_SPHERE', [
    { id: '1', name: 'PEDESTAL' },
    { id: '2', name: 'SPHERE_AGT_01' },
  ])
  assert.equal(hit?.name, 'SPHERE_AGT_01')
})

test('a name nothing answers to stays unmatched', () => {
  // So the caller can decide to create it rather than animating the pedestal.
  assert.equal(bestMatch('HERO_SPHERE', SET_DAY), null)
})

// ---- tokenizing ----

test('names split on separators and case', () => {
  assert.deepEqual(tokenize('HERO_SPHERE'), ['hero', 'sphere'])
  assert.deepEqual(tokenize('SET_SIGN'), ['set', 'sign'])
  assert.deepEqual(tokenize('heroSphere'), ['hero', 'sphere'])
  assert.deepEqual(tokenize('the ball'), ['ball'])
})

test('generated-name noise is dropped', () => {
  // SPHERE_AGT_01 should read as "sphere", not as three equal words.
  assert.deepEqual(tokenize('SPHERE_AGT_01'), ['sphere'])
})

// ---- ordering guarantees ----

test('an exact match always beats a fuzzy one', () => {
  const objs = [
    { id: '1', name: 'SPHERE_AGT_01' },
    { id: '2', name: 'HERO_SPHERE' },
  ]
  assert.equal(bestMatch('HERO_SPHERE', objs)?.name, 'HERO_SPHERE')
  assert.ok(scoreMatch('HERO_SPHERE', 'HERO_SPHERE') > scoreMatch('HERO_SPHERE', 'SPHERE_AGT_01'))
})

test('shared words beat a bare kind match', () => {
  assert.ok(scoreMatch('hero sphere', 'HERO_PROP') > scoreMatch('hero sphere', 'BALL_02'))
})

test('matching is case-insensitive', () => {
  assert.equal(bestMatch('sneaker_one', SET_DAY)?.name, 'SNEAKER_ONE')
  assert.equal(bestMatch('Pedestal', SET_DAY)?.name, 'PEDESTAL')
})

// ---- the "ball" case, generalised ----

test('the old hard-coded ball case still works, via kind', () => {
  const objs = [{ id: '1', name: 'BOX_01' }, { id: '2', name: 'SPHERE_AGT_01' }]
  assert.equal(bestMatch('ball', objs)?.name, 'SPHERE_AGT_01')
  assert.equal(bestMatch('the ball', objs)?.name, 'SPHERE_AGT_01')
})

test('kind words work for every primitive, not just spheres', () => {
  const objs = [
    { id: '1', name: 'SPHERE_AGT_01' },
    { id: '2', name: 'BOX_AGT_02' },
    { id: '3', name: 'TORUS_AGT_03' },
  ]
  assert.equal(bestMatch('cube', objs)?.name, 'BOX_AGT_02')
  assert.equal(bestMatch('donut', objs)?.name, 'TORUS_AGT_03')
  assert.equal(bestMatch('orb', objs)?.name, 'SPHERE_AGT_01')
})

test('a kind match never overrides a real name match', () => {
  // "sign" is a text-kind word, but SET_SIGN is literally named it.
  assert.equal(bestMatch('sign', SET_DAY)?.name, 'SET_SIGN')
})

// ---- what to create when nothing fits ----

test('the primitive to spawn is read from the name', () => {
  assert.equal(primitiveForName('HERO_SPHERE'), 'sphere')
  assert.equal(primitiveForName('BIG_CUBE'), 'box')
  assert.equal(primitiveForName('title card'), 'text')
})

test('an unrecognisable name still spawns something showable', () => {
  // Never null — the caller's whole point is that it can always proceed.
  assert.equal(primitiveForName('ZORBLAX'), 'sphere')
  assert.equal(primitiveForName(''), 'sphere')
})

// ---- degenerate input ----

test('empty and whitespace names match nothing', () => {
  assert.equal(bestMatch('', SET_DAY), null)
  assert.equal(bestMatch('   ', SET_DAY), null)
  assert.equal(scoreMatch('', 'PEDESTAL'), 0)
})

test('an empty set matches nothing rather than throwing', () => {
  assert.equal(bestMatch('anything', []), null)
})
