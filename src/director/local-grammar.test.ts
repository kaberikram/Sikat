import assert from 'node:assert/strict'
import test from 'node:test'

import { parseOfflineClauses, PLACEHOLDERS, OFFLINE_SUGGESTIONS } from './local-grammar.ts'
import { OVERLAY_COMMANDS } from '../ui/overlay-commands.ts'

function handledByOverlay(text: string): boolean {
  const t = text.toLowerCase()
  return OVERLAY_COMMANDS.some(
    (cmd) => cmd.openPhrases.some((re) => re.test(t)) || cmd.closePhrases.some((re) => re.test(t))
  )
}

test('every rotating placeholder works offline', () => {
  for (const placeholder of PLACEHOLDERS) {
    const parsed = parseOfflineClauses(placeholder)
    assert.ok(
      parsed !== null || handledByOverlay(placeholder),
      `placeholder would fail offline: "${placeholder}"`
    )
  }
})

test('every offline suggestion actually parses', () => {
  for (const suggestion of OFFLINE_SUGGESTIONS) {
    assert.notEqual(parseOfflineClauses(suggestion), null, `suggestion fails: "${suggestion}"`)
  }
})

test('compound "then" cue yields one spec per clause', () => {
  const specs = parseOfflineClauses('add a red box then dim the lights')
  assert.ok(specs)
  assert.equal(specs.length, 2)
  assert.equal(specs[0].body.command, 'SPAWN_OBJECT')
  assert.equal(specs[1].body.command, 'UPDATE_LIGHTS')
})

test('spawn parses color and primitive aliases', () => {
  const red = parseOfflineClauses('add a red box')
  assert.ok(red)
  assert.deepEqual(red[0].body.payload, { primitive: 'box', color: '#ff3b30' })

  const plain = parseOfflineClauses('spawn a torus')
  assert.ok(plain)
  assert.deepEqual(plain[0].body.payload, { primitive: 'torus' })

  const alias = parseOfflineClauses('drop a ball')
  assert.ok(alias)
  assert.equal((alias[0].body.payload as { primitive: string }).primitive, 'sphere')

  assert.equal(parseOfflineClauses('add a giant box'), null, 'unknown modifier must fall through')
})

test('motion cues resolve through motion-synth aliases', () => {
  const make = parseOfflineClauses('make the sneaker float')
  assert.ok(make)
  assert.equal(make[0].body.command, 'ANIMATE_OBJECT')
  assert.equal((make[0].body.payload as { motion: string }).motion, 'float')

  const verbFirst = parseOfflineClauses('spin the sneaker')
  assert.ok(verbFirst)
  assert.equal((verbFirst[0].body.payload as { motion: string }).motion, 'spin')

  assert.equal(parseOfflineClauses('greet the sneaker'), null)
})

test('relative move parses amount and duration', () => {
  const specs = parseOfflineClauses('move the box up 2 over 3 seconds')
  assert.ok(specs)
  const body = specs[0].body
  assert.equal(body.command, 'TRANSFORM_OBJECT')
  assert.deepEqual((body.payload as { position: number[] }).position, [0, 2, 0])
  assert.equal(body.transition?.durationSec, 3)
})

test('fx toggles map words to sections', () => {
  const on = parseOfflineClauses('enable bloom')
  assert.ok(on)
  assert.deepEqual(on[0].body.payload, { section: 'bloom', patch: { enabled: true } })

  const off = parseOfflineClauses('turn off dither')
  assert.ok(off)
  assert.deepEqual(off[0].body.payload, { section: 'dither', patch: { enabled: false } })
})

test('lighting moods parse', () => {
  for (const cue of ['golden hour', 'dim the lights', 'noir', 'neon night', 'studio']) {
    const specs = parseOfflineClauses(cue)
    assert.ok(specs, `mood fails: "${cue}"`)
    assert.equal(specs[0].body.command, 'UPDATE_LIGHTS')
  }
})

test('freeform text falls through to the server path', () => {
  assert.equal(parseOfflineClauses('paint everything like a monet'), null)
  assert.equal(parseOfflineClauses(''), null)
})
