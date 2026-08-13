import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BAND_GAP,
  BEZEL_BOTTOM,
  BEZEL_H,
  BEZEL_RADIUS,
  BEZEL_TOP,
  BEZEL_W,
  CANVAS_H,
  CANVAS_W,
  CARD_H,
  CARD_W,
  DOCK_BOTTOM,
  DOCK_GROOVE_W,
  DOCK_TOP,
  DOCK_Y,
  FILM_H,
  FILM_INSET,
  FILM_RADIUS,
  FILM_W,
  FILM_Y,
  HEADER_BOTTOM,
  HEADER_Y,
  PLAY_H,
  PLAY_W,
  PLAY_X,
  SCRUB_H,
  SCRUB_W,
  SCRUB_X,
  TITLE_W,
  TITLE_X,
  canvasX,
  canvasY,
} from './review-layout.ts'

// ---- the three bands must not overlap ----

test('the header clears the film with a real gap', () => {
  // The bug: the title chip and legend sat at ~0.405 while the film reached
  // ~0.395, so the header painted straight over the video.
  assert.ok(HEADER_BOTTOM > BEZEL_TOP, `header ${HEADER_BOTTOM} vs bezel ${BEZEL_TOP}`)
  assert.ok(
    HEADER_BOTTOM - BEZEL_TOP >= BAND_GAP - 1e-9,
    `gap ${HEADER_BOTTOM - BEZEL_TOP} should be at least ${BAND_GAP}`
  )
})

test('the film clears the dock with a real gap', () => {
  assert.ok(BEZEL_BOTTOM > DOCK_TOP, `bezel ${BEZEL_BOTTOM} vs dock ${DOCK_TOP}`)
  assert.ok(
    BEZEL_BOTTOM - DOCK_TOP >= BAND_GAP - 1e-9,
    `gap ${BEZEL_BOTTOM - DOCK_TOP} should be at least ${BAND_GAP}`
  )
})

test('the gaps are a few centimetres, not a hairline', () => {
  assert.ok(BAND_GAP >= 0.02, 'a sub-2cm gap reads as touching at arm’s length')
})

test('the bands run top to bottom in the order they are drawn', () => {
  assert.ok(HEADER_Y > FILM_Y, 'header above film')
  assert.ok(FILM_Y > DOCK_Y, 'film above dock')
})

// ---- everything stays on the card ----

test('every band sits inside the card', () => {
  const top = CARD_H / 2
  const bottom = -CARD_H / 2
  assert.ok(HEADER_Y < top && HEADER_Y > bottom)
  assert.ok(DOCK_Y > bottom, `dock ${DOCK_Y} fell off the bottom`)
  assert.ok(BEZEL_TOP < top && BEZEL_BOTTOM > bottom)
})

test('the film and its bezel fit the card width', () => {
  assert.ok(BEZEL_W < CARD_W, `bezel ${BEZEL_W} wider than card ${CARD_W}`)
  assert.ok(DOCK_GROOVE_W < CARD_W)
})

test('the dock controls stay inside the groove', () => {
  const grooveLeft = -DOCK_GROOVE_W / 2
  const grooveRight = DOCK_GROOVE_W / 2
  assert.ok(PLAY_X - PLAY_W / 2 >= grooveLeft, 'play pill overhangs the groove')
  assert.ok(SCRUB_X + SCRUB_W / 2 <= grooveRight + 1e-9, 'scrub overhangs the groove')
  // …and the two do not collide with each other.
  assert.ok(SCRUB_X - SCRUB_W / 2 > PLAY_X + PLAY_W / 2, 'scrub runs into the play pill')
})

test('the title chip stays inside the card', () => {
  assert.ok(TITLE_X - TITLE_W / 2 > -CARD_W / 2)
  assert.ok(TITLE_X + TITLE_W / 2 < CARD_W / 2)
})

// ---- geometry the look depends on ----

test('the film is 16:9', () => {
  assert.ok(Math.abs(FILM_W / FILM_H - 16 / 9) < 1e-9, `aspect ${FILM_W / FILM_H}`)
})

test('the bezel is the film plus an even reveal', () => {
  assert.ok(Math.abs(BEZEL_W - FILM_W - FILM_INSET * 2) < 1e-9)
  assert.ok(Math.abs(BEZEL_H - FILM_H - FILM_INSET * 2) < 1e-9)
})

test('the film corners are concentric with the bezel corners', () => {
  // An inner rect inset by d from an outer of radius R needs radius R − d, or
  // the corners visibly disagree — the "square corners through the glass" look.
  assert.ok(FILM_RADIUS > 0, 'a zero radius is a sharp corner again')
  assert.ok(Math.abs(FILM_RADIUS - (BEZEL_RADIUS - FILM_INSET)) < 1e-9)
})

test('the film corner radius stays smaller than the film', () => {
  assert.ok(FILM_RADIUS * 2 < FILM_H, 'radius would swallow the picture')
})

// ---- canvas mapping ----

test('world centre maps to canvas centre', () => {
  assert.equal(canvasX(0), CANVAS_W / 2)
  assert.equal(canvasY(0), CANVAS_H / 2)
})

test('canvas y is flipped — world up is canvas down', () => {
  // Getting this backwards silently paints the header over the dock.
  assert.ok(canvasY(HEADER_Y) < canvasY(DOCK_Y), 'header should paint higher up')
})

test('the card edges map to the canvas edges', () => {
  assert.ok(Math.abs(canvasX(-CARD_W / 2)) < 1e-9)
  assert.ok(Math.abs(canvasX(CARD_W / 2) - CANVAS_W) < 1e-9)
  assert.ok(Math.abs(canvasY(CARD_H / 2)) < 1e-9)
  assert.ok(Math.abs(canvasY(-CARD_H / 2) - CANVAS_H) < 1e-9)
})

test('both transport controls fit the dock band', () => {
  // They share DOCK_Y in the meshes, so the row only reads as one line if the
  // taller of the two still sits inside the painted groove.
  const tallest = Math.max(PLAY_H, SCRUB_H)
  assert.ok(DOCK_Y + tallest / 2 <= DOCK_TOP + 1e-9, 'control overflows the groove top')
  assert.ok(DOCK_Y - tallest / 2 >= DOCK_BOTTOM - 1e-9, 'control overflows the groove bottom')
})
