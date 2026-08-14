import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeUtterance,
  parseOfflineClauses,
  PLACEHOLDERS,
  OFFLINE_SUGGESTIONS,
} from './local-grammar.ts'
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

test('spawn carries a spatial anchor instead of landing centre stage', () => {
  const beside = parseOfflineClauses('spawn a box beside the cylinder')
  assert.ok(beside)
  assert.deepEqual(beside[0].body.payload, {
    primitive: 'box',
    anchor: { target: { name: 'cylinder' }, relation: 'beside' },
  })

  const on = parseOfflineClauses('put a sphere on the pedestal')
  assert.ok(on)
  assert.deepEqual((on[0].body.payload as { anchor: unknown }).anchor, {
    target: { name: 'pedestal' },
    relation: 'on',
  })

  // The primitive comes from the half of the cue before the relation — a
  // cylinder next to a box is not a box.
  const ordering = parseOfflineClauses('add a red cylinder next to the box')
  assert.ok(ordering)
  assert.deepEqual(ordering[0].body.payload, {
    primitive: 'cylinder',
    color: '#ff3b30',
    anchor: { target: { name: 'box' }, relation: 'beside' },
  })
})

test('every placement phrase maps to a relation the client can resolve', () => {
  const cases: [string, string][] = [
    ['on top of the pedestal', 'on'],
    ['above the pedestal', 'above'],
    ['over the pedestal', 'above'],
    ['alongside the pedestal', 'beside'],
    ['in front of the pedestal', 'in_front_of'],
    ['behind the pedestal', 'behind'],
    ['on the left of the pedestal', 'left_of'],
    ['to the right of the pedestal', 'right_of'],
  ]
  for (const [phrase, relation] of cases) {
    const specs = parseOfflineClauses(`add a cone ${phrase}`)
    assert.ok(specs, `placement fails: "${phrase}"`)
    const { anchor } = specs[0].body.payload as { anchor: { relation: string } }
    assert.equal(anchor.relation, relation, phrase)
  }
})

test('placement cues that need session memory fall through to the server', () => {
  // "beside it" needs the last-addressed target; parsing here is pure.
  assert.equal(parseOfflineClauses('spawn a box beside it'), null)
  // A definite article plus a destination is a move, not a spawn.
  assert.equal(parseOfflineClauses('place the sphere on the pedestal'), null)
  // Relations the anchor resolver has no answer for stay with the LLM.
  assert.equal(parseOfflineClauses('add a box under the pedestal'), null)
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

test('normalization strips the punctuation speech engines add', () => {
  // Deepgram runs with punctuate + smart_format; these are the exact shapes the
  // most-used on-set cues arrive in, and every matcher for them is anchored.
  assert.equal(normalizeUtterance('Cut.'), 'Cut')
  assert.equal(normalizeUtterance('Action!'), 'Action')
  assert.equal(normalizeUtterance('Show timeline.'), 'Show timeline')
  assert.equal(normalizeUtterance('Play.'), 'Play')
  assert.equal(normalizeUtterance('  golden hour  '), 'golden hour')
  assert.equal(normalizeUtterance('add   a  red   box'), 'add a red box')
})

test('normalization drops leading fillers but never the cue itself', () => {
  assert.equal(normalizeUtterance('Okay, cut.'), 'cut')
  assert.equal(normalizeUtterance('Um, golden hour.'), 'golden hour')
  assert.equal(normalizeUtterance('So, well, action.'), 'action')
  assert.equal(normalizeUtterance('Alright, add a red box.'), 'add a red box')
  // An all-filler utterance keeps its words rather than normalizing to nothing.
  assert.equal(normalizeUtterance('Okay.'), 'Okay')
})

test('normalization leaves the suggestion-accept cues alone', () => {
  for (const cue of ['yes', 'yeah', 'sure', 'do it']) {
    assert.equal(normalizeUtterance(cue), cue, `must survive: "${cue}"`)
  }
})

test('normalization straightens curly apostrophes', () => {
  assert.equal(normalizeUtterance('that’s a wrap'), "that's a wrap")
})

test('spoken cues survive normalization into the offline grammar', () => {
  for (const placeholder of PLACEHOLDERS) {
    const spoken = `Okay, ${placeholder.charAt(0).toUpperCase()}${placeholder.slice(1)}.`
    const normalized = normalizeUtterance(spoken).toLowerCase()
    assert.ok(
      parseOfflineClauses(normalized) !== null || handledByOverlay(normalized),
      `spoken form would fail: "${spoken}"`
    )
  }
})

import { WRAP_CUE_RE, MONITOR_RECALL_RE } from './local-grammar.ts'

test('wrap cues match, near-misses do not', () => {
  for (const cue of ["that's a wrap", 'thats a wrap', 'wrap it up', 'exit xr', 'exit the headset', 'leave the set', 'wrap for today']) {
    assert.ok(WRAP_CUE_RE.test(cue), `should match: "${cue}"`)
  }
  for (const miss of ['wrap the sandwich', "that's a wrap party", 'exit strategy', 'wrap']) {
    assert.equal(WRAP_CUE_RE.test(miss), false, `must not match: "${miss}"`)
  }
})

test('monitor recall cues match, near-misses do not', () => {
  for (const cue of ["where's the monitor", 'where is the monitor', 'show me the take', 'bring back the review', 'show the replay']) {
    assert.ok(MONITOR_RECALL_RE.test(cue), `should match: "${cue}"`)
  }
  for (const miss of ['monitor the situation', 'show me around', 'take five']) {
    assert.equal(MONITOR_RECALL_RE.test(miss), false, `must not match: "${miss}"`)
  }
})
