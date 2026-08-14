import assert from 'node:assert/strict'
import test from 'node:test'
import { LABEL_BOTTOM, STATUS_GAP, statusSlotY } from './agent-cursor-layout.ts'

/** The three heights agent-cursors.ts actually places: spinner, 1-line, 2-line. */
const HEIGHTS = [0.12, 0.18, 0.24]

test('every status height clears the name badge', () => {
  for (const worldH of HEIGHTS) {
    const top = statusSlotY(worldH) + worldH / 2
    assert.ok(
      top <= LABEL_BOTTOM,
      `a ${worldH} sprite reaches ${top}, above the badge's ${LABEL_BOTTOM}`
    )
  }
})

test('the gap under the badge is the same whatever the height', () => {
  for (const worldH of HEIGHTS) {
    const top = statusSlotY(worldH) + worldH / 2
    assert.equal(Number((LABEL_BOTTOM - top).toFixed(6)), STATUS_GAP)
  }
})

test('a taller note hangs lower rather than climbing into the title', () => {
  assert.ok(statusSlotY(0.24) < statusSlotY(0.18))
  assert.ok(statusSlotY(0.18) < statusSlotY(0.12))
})
