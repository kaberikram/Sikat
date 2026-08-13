/**
 * The take-review card's layout, in one place.
 *
 * The card is drawn twice — as canvas chrome (`makeReviewCardTexture`) and as
 * world meshes (`review-screen.ts`) — and the two used to carry the same
 * numbers independently, with a comment asking future editors to keep them in
 * step. They drifted: the title chip and legend sat at y ≈ 0.405 while the film
 * reached 0.395, so the header painted straight over the top of the video.
 *
 * So both read from here instead. World metres are the source of truth and the
 * canvas is derived, which is the direction that can't rot: a band that fits in
 * metres cannot fail to fit in pixels.
 *
 * This is a sibling module rather than an export from `review-screen.ts`
 * because the chrome painter is imported *by* the screen — putting the shared
 * constants in the screen would make that a cycle. It also keeps the layout
 * free of three.js, so the stacking rules are unit-testable on their own.
 */

/** Card plane, in metres. */
export const CARD_W = 1.35
export const CARD_H = 1.01

/** Canvas the chrome is painted into. Aspect ≈ the card's, so px are ~square. */
export const CANVAS_W = 2048
export const CANVAS_H = 1536

/** Transparent margin the glass shadow bleeds into, before clipping. */
export const GLASS_PAD_PX = 48
export const GLASS_RADIUS_PX = 88

/** Metres → canvas px. Separate axes so a non-matching aspect can't skew a band. */
export const pxX = (m: number): number => (m / CARD_W) * CANVAS_W
export const pxY = (m: number): number => (m / CARD_H) * CANVAS_H
/** World x (centre origin, +right) → canvas x. */
export const canvasX = (m: number): number => CANVAS_W / 2 + pxX(m)
/** World y (centre origin, **+up**) → canvas y (top origin, **+down**). */
export const canvasY = (m: number): number => CANVAS_H / 2 - pxY(m)

/** Where the painted glass body actually starts, inside the shadow margin. */
const GLASS_INSET = (GLASS_PAD_PX / CANVAS_H) * CARD_H
/** Breathing room between the glass edge and any content. */
const CONTENT_PAD = 0.03
/** Clear space between the three bands. The overlap this file exists to fix. */
export const BAND_GAP = 0.025

const CONTENT_TOP = CARD_H / 2 - GLASS_INSET - CONTENT_PAD
const CONTENT_BOTTOM = -CARD_H / 2 + GLASS_INSET + CONTENT_PAD
const CONTENT_LEFT = -CARD_W / 2 + GLASS_INSET + CONTENT_PAD
const CONTENT_RIGHT = CARD_W / 2 - GLASS_INSET - CONTENT_PAD

// ---- header: title left, hint right, entirely above the film ----

export const HEADER_H = 0.11
export const HEADER_TOP = CONTENT_TOP
export const HEADER_BOTTOM = CONTENT_TOP - HEADER_H
export const HEADER_Y = (HEADER_TOP + HEADER_BOTTOM) / 2

export const TITLE_W = 0.40
export const TITLE_H = 0.072
/** Left-aligned in the header band. */
export const TITLE_X = CONTENT_LEFT + TITLE_W / 2
export const HINT_RIGHT_X = CONTENT_RIGHT

// ---- dock: play + scrub on one baseline, entirely below the film ----

export const DOCK_H = 0.12
export const DOCK_BOTTOM = CONTENT_BOTTOM
export const DOCK_TOP = CONTENT_BOTTOM + DOCK_H
export const DOCK_Y = (DOCK_TOP + DOCK_BOTTOM) / 2

export const DOCK_GROOVE_W = CONTENT_RIGHT - CONTENT_LEFT
/** Inset from the groove ends to the controls. */
const DOCK_PAD = 0.04
/** Between the play pill and the start of the scrub track. */
const DOCK_GUTTER = 0.05

export const PLAY_W = 0.3
export const PLAY_H = 0.095
export const PLAY_X = CONTENT_LEFT + DOCK_PAD + PLAY_W / 2

const SCRUB_LEFT = PLAY_X + PLAY_W / 2 + DOCK_GUTTER
const SCRUB_RIGHT = CONTENT_RIGHT - DOCK_PAD
export const SCRUB_W = SCRUB_RIGHT - SCRUB_LEFT
export const SCRUB_X = (SCRUB_LEFT + SCRUB_RIGHT) / 2
/** Slim next to the play pill, but both are centred on DOCK_Y so the transport
 *  reads as one row rather than two things at slightly different heights. */
export const SCRUB_H = 0.05
export const THUMB_D = 0.058

// ---- film: 16:9, inside a rounded bezel, filling what's left ----

/** Dark reveal between the film edge and the bezel edge. */
export const FILM_INSET = 0.02
export const BEZEL_RADIUS = 0.04
/**
 * Concentric with the bezel: an inner rounded rect inset by `d` from an outer
 * one of radius `R` has radius `R − d`. Anything else and the corners visibly
 * disagree, which is the "square corners punching through the glass" look.
 */
export const FILM_RADIUS = BEZEL_RADIUS - FILM_INSET

/** The band the *bezel* occupies — the film is this minus the reveal. */
const MID_TOP = HEADER_BOTTOM - BAND_GAP
const MID_BOTTOM = DOCK_TOP + BAND_GAP

/**
 * Sized from the bezel outward, not the film.
 *
 * Fitting the film to the gap and then painting a bezel around it is how the
 * dark plate ends up wider than the space it was measured for — the reveal has
 * to come out of the budget before the 16:9 is derived.
 */
export const FILM_H = Math.min(
  MID_TOP - MID_BOTTOM - FILM_INSET * 2,
  (CONTENT_RIGHT - CONTENT_LEFT - FILM_INSET * 2) * (9 / 16)
)
export const FILM_W = FILM_H * (16 / 9)
export const FILM_Y = (MID_TOP + MID_BOTTOM) / 2

export const BEZEL_W = FILM_W + FILM_INSET * 2
export const BEZEL_H = FILM_H + FILM_INSET * 2

/** Edges of the visible dark plate — what actually has to clear the bands. */
export const BEZEL_TOP = FILM_Y + BEZEL_H / 2
export const BEZEL_BOTTOM = FILM_Y - BEZEL_H / 2
