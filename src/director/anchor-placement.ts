/**
 * Resolving "on the pedestal" into a world position.
 *
 * The crew names a relationship; this works out where that actually is, using
 * the anchor's real bounds at the moment of placing. That timing is the whole
 * reason it lives on the client: a Y the server computed goes stale the instant
 * the anchor animates, gets rescaled, or the stage relocates — which in XR it
 * does, to wherever the director is standing.
 *
 * Pure and free of three.js so it can be unit tested; `command-applier.ts` is
 * the shell that measures the live mesh and calls in. Same split as
 * `cursor-lifecycle.ts` and `link-health.ts`.
 */
import type { AnchorRelation, Vec3 } from './protocol'

/** World-space axis-aligned bounds of something already on set. */
export interface AnchorBox {
  min: Vec3
  max: Vec3
}

/** Breathing room left between two objects placed side by side. */
export const BESIDE_GAP_M = 0.08

/**
 * How far above a surface `above` floats, as a fraction of the anchor's height.
 *
 * Proportional rather than fixed: "above the pedestal" and "above the sneaker"
 * should both read as hovering, and a constant that looks right over a 0.84m
 * pedestal buries a 0.11m shoe.
 */
export const ABOVE_LIFT_FRACTION = 0.5
/** …but never less than this, or "above" a flat object is indistinguishable from "on". */
export const ABOVE_LIFT_MIN_M = 0.12

const center = (b: AnchorBox): Vec3 => [
  (b.min[0] + b.max[0]) / 2,
  (b.min[1] + b.max[1]) / 2,
  (b.min[2] + b.max[2]) / 2,
]

const size = (b: AnchorBox): Vec3 => [
  b.max[0] - b.min[0],
  b.max[1] - b.min[1],
  b.max[2] - b.min[2],
]

/** Half the larger horizontal extent — one number for clearance. */
function footprintRadius(b: AnchorBox): number {
  const [sx, , sz] = size(b)
  return Math.max(sx, sz) / 2
}

/**
 * Where the *centre* of `moving` has to be for the relation to hold.
 *
 * Takes the mover's own bounds because placing is about surfaces, not origins:
 * sitting a shoe on a pedestal means its underside meets the pedestal's top, and
 * that depends on how far the shoe's base sits below its own centre. Passing
 * null falls back to treating the mover as a point, which is right for a spawn
 * whose mesh does not exist yet.
 */
export function resolveAnchor(
  relation: AnchorRelation,
  anchor: AnchorBox,
  moving: AnchorBox | null,
  /** Camera position, so front/behind mean what the shot sees. */
  cameraPos?: Vec3 | null,
  offset?: Vec3 | null
): Vec3 {
  const [ax, ay, az] = center(anchor)
  const movingHalfHeight = moving ? size(moving)[1] / 2 : 0
  const movingRadius = moving ? footprintRadius(moving) : 0

  let out: Vec3
  switch (relation) {
    case 'on':
      out = [ax, anchor.max[1] + movingHalfHeight, az]
      break
    case 'above': {
      const lift = Math.max(ABOVE_LIFT_MIN_M, size(anchor)[1] * ABOVE_LIFT_FRACTION)
      out = [ax, anchor.max[1] + lift + movingHalfHeight, az]
      break
    }
    case 'beside': {
      // Along the axis the anchor is narrowest on, so a wide backdrop gets a
      // neighbour at its end rather than buried against its long face.
      const [sx, , sz] = size(anchor)
      const gap = footprintRadius(anchor) + movingRadius + BESIDE_GAP_M
      out = sx <= sz ? [ax + gap, ay, az] : [ax, ay, az + gap]
      break
    }
    case 'in_front_of':
    case 'behind': {
      const dir = towardCamera(center(anchor), cameraPos)
      const reach = footprintRadius(anchor) + movingRadius + BESIDE_GAP_M
      const sign = relation === 'in_front_of' ? 1 : -1
      out = [ax + dir[0] * reach * sign, ay, az + dir[2] * reach * sign]
      break
    }
  }

  if (offset) return [out[0] + offset[0], out[1] + offset[1], out[2] + offset[2]]
  return out
}

/**
 * Unit vector on the floor plane from the anchor toward the camera.
 *
 * "In front of" is from the shot's point of view, not the world's — a world-axis
 * answer is wrong the moment the camera moves, which is most of the time on a
 * set. Falls back to +Z (the editor's default camera side) when there is no
 * camera to ask or it is directly overhead.
 */
function towardCamera(anchorCenter: Vec3, cameraPos?: Vec3 | null): Vec3 {
  if (!cameraPos) return [0, 0, 1]
  const dx = cameraPos[0] - anchorCenter[0]
  const dz = cameraPos[2] - anchorCenter[2]
  const len = Math.hypot(dx, dz)
  if (len < 1e-4) return [0, 0, 1]
  return [dx / len, 0, dz / len]
}
