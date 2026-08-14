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
export function footprintRadius(b: AnchorBox): number {
  const [sx, , sz] = size(b)
  return Math.max(sx, sz) / 2
}

/** How high above the stage floor a prop with no stated height lands. */
export const SPAWN_LIFT_M = 0.5

/**
 * Smallest footprint a prop already on set is treated as having.
 *
 * New props scale in over 0.35s, and a compound cue stages its packets 0.15s
 * apart — so the prop before this one is very likely measured mid-pop, at a
 * fraction of the size it is about to be. Without a floor, the next prop gets
 * placed into the hole the last one is still growing into.
 */
export const MIN_OCCUPANCY_RADIUS_M = 0.15

/**
 * A spot on the stage clear of everything already standing there.
 *
 * "add a box" names no relationship, so there is nothing to resolve and nothing
 * to compute from — and the answer used to be one hard-coded coordinate, which
 * meant every unplaced prop was spawned *inside* the last one. No amount of
 * reading the sentence better can fix that; the sentence genuinely does not say
 * where it goes. So the set decides, by looking at what is already on it.
 *
 * Centre first, because a first prop on an empty stage belongs in the middle;
 * then rings stepping outward until something clears. Deterministic: the same
 * set answers the same way, so a re-run of a take stages identically.
 */
export function findOpenSpot(
  occupied: AnchorBox[],
  stage: { center: Vec3; radius: number },
  movingRadius: number
): Vec3 {
  const y = stage.center[1] + SPAWN_LIFT_M
  const centre: Vec3 = [stage.center[0], y, stage.center[2]]
  if (isClear(centre, movingRadius, occupied)) return centre

  // Step by the mover's own width so consecutive rings cannot overlap, with a
  // floor so a tiny prop does not crawl outward in millimetre increments.
  const step = Math.max(movingRadius * 2 + BESIDE_GAP_M, 0.25)
  for (let ring = 1; ring * step <= stage.radius; ring++) {
    const r = ring * step
    // Enough samples that neighbours on the ring are about a step apart.
    const samples = Math.max(6, Math.round((2 * Math.PI * r) / step))
    for (let i = 0; i < samples; i++) {
      const angle = (i / samples) * Math.PI * 2
      const spot: Vec3 = [
        stage.center[0] + Math.cos(angle) * r,
        y,
        stage.center[2] + Math.sin(angle) * r,
      ]
      if (isClear(spot, movingRadius, occupied)) return spot
    }
  }
  // A full stage is not a reason to refuse the prop. Centre, and let the
  // director move it — same as before, but now only as a genuine last resort.
  return centre
}

/** True when a prop of `radius` centred at `spot` touches nothing. */
function isClear(spot: Vec3, radius: number, occupied: AnchorBox[]): boolean {
  for (const box of occupied) {
    const [cx, , cz] = center(box)
    const gap = Math.hypot(spot[0] - cx, spot[2] - cz)
    const held = Math.max(footprintRadius(box), MIN_OCCUPANCY_RADIUS_M)
    if (gap < held + radius + BESIDE_GAP_M) return false
  }
  return true
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
    case 'left_of':
    case 'right_of': {
      const right = cameraRight(center(anchor), cameraPos)
      const reach = footprintRadius(anchor) + movingRadius + BESIDE_GAP_M
      const sign = relation === 'right_of' ? 1 : -1
      out = [ax + right[0] * reach * sign, ay, az + right[2] * reach * sign]
      break
    }
    default: {
      const _exhaustive: never = relation
      throw new Error(`unhandled anchor relation: ${_exhaustive}`)
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

/** Camera-right on the floor plane. `left_of` / `right_of` are from the shot. */
function cameraRight(anchorCenter: Vec3, cameraPos?: Vec3 | null): Vec3 {
  const [tx, , tz] = towardCamera(anchorCenter, cameraPos)
  return [tz, 0, -tx]
}
