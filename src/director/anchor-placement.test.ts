import assert from 'node:assert/strict'
import test from 'node:test'

import { BESIDE_GAP_M, resolveAnchor, type AnchorBox } from './anchor-placement.ts'

/** A box by centre and size — how a person describes a prop. */
const box = (
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number
): AnchorBox => ({
  min: [cx - sx / 2, cy - sy / 2, cz - sz / 2],
  max: [cx + sx / 2, cy + sy / 2, cz + sz / 2],
})

// The SET DAY stack, which is the case that prompted all of this.
const PEDESTAL = box(0, 0.42, 0, 0.54, 0.84, 0.54)
const SNEAKER = box(0, 0.94, 0, 0.26, 0.11, 0.1)

const close = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol

test('"on" lands the mover\'s underside on the anchor\'s top', () => {
  // The number the crew could never compute: pedestal top is 0.84, the shoe is
  // 0.11 tall, so its centre belongs at 0.895.
  const [x, y, z] = resolveAnchor('on', PEDESTAL, SNEAKER)
  assert.ok(close(y, 0.84 + 0.055), `y=${y}`)
  assert.equal(x, 0)
  assert.equal(z, 0)
})

test('"on" without the mover\'s bounds sits at the surface', () => {
  // A spawn has no mesh yet. Treating it as a point is the honest answer —
  // better than guessing a height and burying it.
  const [, y] = resolveAnchor('on', PEDESTAL, null)
  assert.ok(close(y, 0.84), `y=${y}`)
})

test('stacking is idempotent — resolving twice does not creep upward', () => {
  const first = resolveAnchor('on', PEDESTAL, SNEAKER)
  const moved: AnchorBox = box(first[0], first[1], first[2], 0.26, 0.11, 0.1)
  const second = resolveAnchor('on', PEDESTAL, moved)
  assert.deepEqual(first, second)
})

test('"above" hovers clear of the surface rather than touching it', () => {
  const onY = resolveAnchor('on', PEDESTAL, SNEAKER)[1]
  const aboveY = resolveAnchor('above', PEDESTAL, SNEAKER)[1]
  assert.ok(aboveY > onY, `above ${aboveY} should clear on ${onY}`)
})

test('"above" a flat object still reads as hovering', () => {
  // A proportional lift alone would be ~1mm over a sign; the floor is what
  // keeps "above" distinguishable from "on".
  const sign = box(0, 1.5, 0, 0.5, 0.02, 0.02)
  const onY = resolveAnchor('on', sign, null)[1]
  const aboveY = resolveAnchor('above', sign, null)[1]
  assert.ok(aboveY - onY >= 0.1, `lift was only ${aboveY - onY}`)
})

test('"beside" clears both footprints plus a gap', () => {
  const cube = box(0, 0.14, 0, 0.28, 0.28, 0.28)
  const [x, , z] = resolveAnchor('beside', PEDESTAL, cube)
  const gap = Math.hypot(x, z) - 0.27 - 0.14
  assert.ok(close(gap, BESIDE_GAP_M, 1e-6), `gap=${gap}`)
})

test('"beside" a wide backdrop goes to its end, not its long face', () => {
  // A wall-like object: 3m across, 0.1m deep. Beside it means past the end.
  const backdrop = box(0, 1, 0, 3, 2, 0.1)
  const [x, , z] = resolveAnchor('beside', backdrop, null)
  assert.ok(Math.abs(z) > Math.abs(x), `expected offset along Z, got x=${x} z=${z}`)
})

test('"in front of" is toward the camera, not a world axis', () => {
  // Camera off to +X: in front must move toward +X, not the default +Z.
  const camera: [number, number, number] = [5, 1, 0]
  const [x, , z] = resolveAnchor('in_front_of', PEDESTAL, null, camera)
  assert.ok(x > 0, `x=${x}`)
  assert.ok(close(z, 0, 1e-6), `z=${z}`)
})

test('"behind" is the opposite side from the camera', () => {
  const camera: [number, number, number] = [5, 1, 0]
  const front = resolveAnchor('in_front_of', PEDESTAL, null, camera)
  const back = resolveAnchor('behind', PEDESTAL, null, camera)
  assert.ok(front[0] > 0 && back[0] < 0, `front=${front[0]} back=${back[0]}`)
})

test('front/behind fall back to the default camera side with no camera', () => {
  const [, , z] = resolveAnchor('in_front_of', PEDESTAL, null, null)
  assert.ok(z > 0, `z=${z}`)
})

test('a camera directly overhead does not produce a zero direction', () => {
  const overhead: [number, number, number] = [0, 9, 0]
  const [x, , z] = resolveAnchor('in_front_of', PEDESTAL, null, overhead)
  assert.ok(Number.isFinite(x) && Number.isFinite(z))
  assert.ok(Math.hypot(x, z) > 0, 'should still be displaced somewhere')
})

test('an offset is applied after the relation resolves', () => {
  const plain = resolveAnchor('on', PEDESTAL, SNEAKER)
  const nudged = resolveAnchor('on', PEDESTAL, SNEAKER, null, [0.1, 0.2, 0.3])
  assert.ok(close(nudged[0] - plain[0], 0.1))
  assert.ok(close(nudged[1] - plain[1], 0.2))
  assert.ok(close(nudged[2] - plain[2], 0.3))
})

test('the stage relocating carries placement with it', () => {
  // In XR the set moves to wherever the director is standing. A relation
  // resolved against live bounds follows; a server-computed Y would not.
  const moved = box(3, 0.42, -2, 0.54, 0.84, 0.54)
  const [x, y, z] = resolveAnchor('on', moved, SNEAKER)
  assert.ok(close(x, 3) && close(z, -2), `x=${x} z=${z}`)
  assert.ok(close(y, 0.84 + 0.055), `y=${y}`)
})
