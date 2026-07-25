import assert from 'node:assert/strict'
import test from 'node:test'

import { cleanUtterance, tidyUtterance, utteranceCandidates } from './utterance.ts'
import { parseOfflineClauses, WRAP_CUE_RE } from './local-grammar.ts'
import { OVERLAY_COMMANDS } from '../ui/overlay-commands.ts'

/**
 * The store-free subset of tryLocalCommand's patterns. Kept in sync by hand so
 * this file stays a pure node test; the browser smoke run covers the rest.
 */
const LOCAL_PATTERNS = [
  /^(undo( that| it)?|go back|revert|scratch that)[!.]?$/,
  /^(do it|yes( please)?|go ahead|sure|make it so)[!.]?$/,
  /^(crew,?\s*)?(set|build|dress)\s+the\s+(stage|set)\b/,
  /^set day$/,
  WRAP_CUE_RE,
  /^(crew,?\s*)?strike\s+the\s+set\b/,
  /^(play|go|resume|continue)$/,
  /^(pause|hold|freeze)$/,
  /^stop$/,
  /^(loop|loop it|keep looping|on repeat)$/,
  /^(play once|no loop|don'?t loop|once only)$/,
  /^(rewind|back to start|back to one|top of scene|from the top|restart)$/,
  /^(?:and\s+)?action$/,
  /^cut$/,
  /^that'?s\s+a\s+cut$/,
  /^stop\s+recording$/,
  /^start\s+recording$/,
  /^we'?re\s+rolling$/,
  /^(help|what can (i|you) (say|do)|commands)\??$/,
  /^(deselect|clear selection)$/,
  /^(hide|close)\s+all$/,
]

function readingResolves(text: string): boolean {
  const t = text.trim().toLowerCase()
  if (LOCAL_PATTERNS.some((re) => re.test(t))) return true
  if (
    OVERLAY_COMMANDS.some((cmd) =>
      [...cmd.openPhrases, ...cmd.closePhrases].some((re) => re.test(t))
    )
  ) {
    return true
  }
  return parseOfflineClauses(text) !== null
}

/** Mirrors tryLocalCommand: first reading that resolves wins. */
function understood(spoken: string): boolean {
  return utteranceCandidates(spoken).some(readingResolves)
}

test('dictated punctuation and capitalization never blocks a cue', () => {
  for (const spoken of [
    'Add a red box.',
    'Golden hour.',
    'Dim the lights.',
    'Enable bloom.',
    'Make the sphere bounce.',
    'Show timeline.',
    'Action!',
    'Cut!',
    'Play.',
    'Pause.',
    'Stop.',
    'Help.',
    'Undo that.',
    'Golden hour?',
    'Crew, set the stage.',
    'Strike the set.',
  ]) {
    assert.ok(understood(spoken), `spoken cue must land: "${spoken}"`)
  }
})

test('"and cut" / "and action" — the cues SET DAY actually coaches', () => {
  for (const spoken of ['and action', 'And action.', 'and cut', 'And cut.', 'And cut!']) {
    assert.ok(understood(spoken), `take cue must land: "${spoken}"`)
  }
})

test('fillers, politeness and courtesy fall away', () => {
  for (const spoken of [
    'Um, add a red box.',
    'Okay, dim the lights.',
    'So, make the sphere bounce.',
    'Alright, enable bloom.',
    'Now dim the lights.',
    'Please add a red box.',
    'Add a red box, please.',
    'Can you add a red box?',
    'Could you dim the lights?',
    "Let's do golden hour.",
    'Go ahead and add a red box.',
    'Enable bloom, thanks.',
    'Hey, could you please dim the lights for me?',
    'I want a red box.',
    'Give me a red box.',
  ]) {
    assert.ok(understood(spoken), `polite phrasing must land: "${spoken}"`)
  }
})

test('addressing the crew by name is stripped', () => {
  for (const spoken of ['Crew, golden hour.', 'Hey crew, add a red box.', 'Director, enable bloom.']) {
    assert.ok(understood(spoken), `addressed cue must land: "${spoken}"`)
  }
})

test('mid-utterance restarts recover from the last fragment', () => {
  assert.ok(understood('Add a, add a red box.'))
  assert.ok(understood('Golden, uh, golden hour.'))
})

test('smart apostrophes match the same patterns as straight ones', () => {
  assert.ok(WRAP_CUE_RE.test(tidyUtterance('That’s a wrap!').toLowerCase()))
  assert.ok(understood('Don’t loop.'))
})

test('spoken numbers become the digits the grammar parses', () => {
  const specs = utteranceCandidates('Move the box up two over three seconds.')
    .map(parseOfflineClauses)
    .find(Boolean)
  assert.ok(specs, 'spoken numbers must parse')
  assert.deepEqual((specs[0].body.payload as { position: number[] }).position, [0, 2, 0])
  assert.equal(specs[0].body.transition?.durationSec, 3)
})

test('a bare "and" joins clauses only when the whole cue fails otherwise', () => {
  const both = parseOfflineClauses('add a red box and dim the lights')
  assert.ok(both)
  assert.equal(both.length, 2)
  assert.equal(both[0].body.command, 'SPAWN_OBJECT')
  assert.equal(both[1].body.command, 'UPDATE_LIGHTS')

  // A cue that parses whole must not be chopped at an interior separator.
  const whole = parseOfflineClauses('move the box up 2 over 3 seconds')
  assert.ok(whole)
  assert.equal(whole.length, 1)
})

test('verbatim text is always the first reading, so literal cues keep priority', () => {
  for (const cue of ['back to one', 'play once', "don't loop", 'do it', 'yes', 'go']) {
    assert.equal(utteranceCandidates(cue)[0], cue, `verbatim must lead: "${cue}"`)
    assert.ok(understood(cue), `literal cue must still resolve: "${cue}"`)
  }
})

test('normalization never invents a command out of freeform direction', () => {
  for (const spoken of [
    'Paint everything like a Monet.',
    'Can you make it feel more cinematic?',
    'Add a giant box.',
    'I want the whole thing to look like Blade Runner.',
    'Um, what do you think of the lighting?',
  ]) {
    assert.equal(understood(spoken), false, `must reach the crew, not the grammar: "${spoken}"`)
  }
})

test('candidates are deduped, non-empty, and never blank out an utterance', () => {
  for (const spoken of ['please', 'okay', 'um', '...', 'thanks', 'crew', 'go']) {
    const candidates = utteranceCandidates(spoken)
    assert.ok(candidates.length > 0, `must not vanish: "${spoken}"`)
    assert.equal(new Set(candidates).size, candidates.length, `duplicate readings: "${spoken}"`)
    for (const c of candidates) assert.ok(c.trim(), `blank reading from "${spoken}"`)
  }
  assert.deepEqual(utteranceCandidates('   '), [])
})

test('cleanUtterance keeps the words, drops the dictation marks', () => {
  assert.equal(cleanUtterance('Add a red box.'), 'Add a red box')
  assert.equal(cleanUtterance('Golden  hour?'), 'Golden hour')
  assert.equal(cleanUtterance('That’s a wrap!'), "That's a wrap")
  assert.equal(cleanUtterance('  '), '')
})
