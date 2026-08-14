/**
 * Where a cursor's status chrome hangs beneath its name badge.
 *
 * The note and the spinner used to share one fixed Y and grow symmetrically
 * about it, so their top edge rose with their own height: a one-line note
 * reached 0.27 and a two-line note 0.30 against a label whose bottom edge sits
 * at 0.225. The taller the message, the deeper it climbed into the title. A
 * bigger constant only moves that failure to the next line count — anchoring
 * the *top* of the slot is what actually fixes it.
 *
 * Pure and free of three.js so it can be unit tested directly, same split as
 * `anchor-placement.ts` and `cursor-lifecycle.ts`.
 */

/** Name badge centre, in metres above the cursor's origin. */
export const LABEL_Y = 0.3
/** Name badge sprite height — `makeLabel` scales the sprite to this. */
export const LABEL_H = 0.15
/** Breathing room between the badge's lower edge and whatever hangs below it. */
export const STATUS_GAP = 0.03

/** Underside of the name badge — the ceiling everything else has to clear. */
export const LABEL_BOTTOM = LABEL_Y - LABEL_H / 2

/**
 * Centre Y for a status sprite of `worldH`, placed so its top edge sits
 * `STATUS_GAP` below the badge regardless of how tall it is.
 */
export function statusSlotY(worldH: number): number {
  return LABEL_BOTTOM - STATUS_GAP - worldH / 2
}
