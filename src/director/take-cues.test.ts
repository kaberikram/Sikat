/**
 * The take cues the SET DAY shot list actually coaches.
 *
 * These exercise the real cue patterns from local-grammar (tryTakeCue itself
 * sits behind store and XR-bridge imports that don't load under node).
 * Beat 3 coaches "action" and beat 4 coaches "and cut"; the stop side allowed
 * no `and` prefix, so the shot list advanced on the word `cut` while the take
 * carried on rolling.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeUtterance, START_CUES, STOP_CUES } from './local-grammar.ts'

const starts = (raw: string) => START_CUES.some((re) => re.test(normalizeUtterance(raw).toLowerCase()))
const stops = (raw: string) => STOP_CUES.some((re) => re.test(normalizeUtterance(raw).toLowerCase()))

test('the shot list cues both roll and cut', () => {
  // These two strings are what demo-shoot puts on screen at beats 3 and 4.
  assert.ok(starts('action'), 'beat 3 cue')
  assert.ok(stops('and cut'), 'beat 4 cue — the one that used to fall through')
})

test('start and stop treat the "and" prefix the same way', () => {
  // The asymmetry was the bug: START_CUES allowed it, STOP_CUES did not.
  assert.equal(starts('and action'), true)
  assert.equal(stops('and cut'), true)
})

test('speech-engine punctuation does not break either cue', () => {
  // Deepgram runs punctuate + smart_format, so cues arrive with a full stop.
  for (const raw of ['Action.', 'And action.', 'Cut.', 'And cut.']) {
    assert.ok(starts(raw) || stops(raw), `${raw} matched nothing`)
  }
})

test('leading fillers are stripped before matching', () => {
  assert.ok(starts('Okay, action.'))
  assert.ok(stops('Alright, cut.'))
})

test('the other roll phrasings still work', () => {
  for (const raw of ["camera's rolling", 'cameras rolling', 'start recording', "we're rolling", 'roll camera', 'roll it']) {
    assert.ok(starts(raw), raw)
  }
})

test('the other cut phrasings still work', () => {
  for (const raw of ["that's a cut", 'stop recording']) {
    assert.ok(stops(raw), raw)
  }
})

test('cues stay anchored — a sentence containing them is not a cue', () => {
  // "make the box cut through the floor" must not end the take.
  for (const raw of ['cut the box in half', 'action figure', 'and cut the lights']) {
    assert.equal(stops(raw) || starts(raw), false, raw)
  }
})

test('roll and cut never both match the same utterance', () => {
  for (const raw of ['action', 'and action', 'cut', 'and cut', "that's a cut", 'start recording']) {
    assert.ok(!(starts(raw) && stops(raw)), `${raw} matched both`)
  }
})
