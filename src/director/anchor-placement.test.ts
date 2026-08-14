import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BESIDE_GAP_M,
  findOpenSpot,
  footprintRadius,
  resolveAnchor,
  SPAWN_LIFT_M,
  type AnchorBox,
} from './anchor-placement.ts'

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

// ---- finding a spot when the direction never named one --------------------
//
// "add a box" says nothing about where it goes. This used to answer with one
// hard-coded coordinate, so the second prop spawned inside the first.

const STAGE = { center: [0, 0, 0] as [number, number, number], radius: 3 }

/** Horizontal gap between two spots, which is all placement cares about. */
const flatGap = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[2] - b[2])

test('an empty stage puts the first prop in the middle', () => {
  const [x, y, z] = findOpenSpot([], STAGE, 0.25)
  assert.equal(x, 0)
  assert.equal(z, 0)
  assert.ok(close(y, SPAWN_LIFT_M), `y=${y}`)
})

test('a second prop clears the first instead of landing inside it', () => {
  const spot = findOpenSpot([PEDESTAL], STAGE, 0.25)
  const clearance = footprintRadius(PEDESTAL) + 0.25 + BESIDE_GAP_M
  assert.ok(
    flatGap(spot, [0, 0, 0]) >= clearance,
    `spot ${spot} is inside the pedestal (needs ${clearance})`
  )
})

test('each new prop finds its own spot on a filling stage', () => {
  const placed: AnchorBox[] = []
  const radius = 0.3
  for (let i = 0; i < 6; i++) {
    const spot = findOpenSpot(placed, STAGE, radius)
    for (const other of placed) {
      const need = footprintRadius(other) + radius + BESIDE_GAP_M
      assert.ok(flatGap(spot, [
        (other.min[0] + other.max[0]) / 2,
        0,
        (other.min[2] + other.max[2]) / 2,
      ]) >= need, `prop ${i} overlaps an earlier one`)
    }
    placed.push({
      min: [spot[0] - radius, 0, spot[2] - radius],
      max: [spot[0] + radius, 1, spot[2] + radius],
    })
  }
})

test('props stay on the stage', () => {
  const placed: AnchorBox[] = []
  for (let i = 0; i < 12; i++) {
    const spot = findOpenSpot(placed, STAGE, 0.3)
    assert.ok(
      flatGap(spot, [0, 0, 0]) <= STAGE.radius,
      `prop ${i} walked off the stage to ${spot}`
    )
    placed.push({
      min: [spot[0] - 0.3, 0, spot[2] - 0.3],
      max: [spot[0] + 0.3, 1, spot[2] + 0.3],
    })
  }
})

test('the same set always stages the same way', () => {
  const first = findOpenSpot([PEDESTAL, SNEAKER], STAGE, 0.25)
  const again = findOpenSpot([PEDESTAL, SNEAKER], STAGE, 0.25)
  assert.deepEqual(first, again)
})

test('a full stage still places the prop rather than refusing it', () => {
  const wall: AnchorBox[] = []
  for (let x = -3; x <= 3; x += 0.5) {
    for (let z = -3; z <= 3; z += 0.5) {
      wall.push({ min: [x - 0.25, 0, z - 0.25], max: [x + 0.25, 1, z + 0.25] })
    }
  }
  const [x, , z] = findOpenSpot(wall, STAGE, 0.25)
  assert.equal(x, 0)
  assert.equal(z, 0)
})

test('a prop still mid entrance-pop is not spawned into', () => {
  // A box 0.15s into its 0.35s pop measures ~40% of full size. The next prop
  // must reserve room for what it is becoming, not what it momentarily is.
  const popping = box(0, 0.1, 0, 0.02, 0.02, 0.02)
  const spot = findOpenSpot([popping], STAGE, 0.25)
  assert.ok(flatGap(spot, [0, 0, 0]) > 0.25, `landed on the popping prop at ${spot}`)
})
