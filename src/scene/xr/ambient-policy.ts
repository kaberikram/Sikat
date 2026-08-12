/**
 * Ambient surface policy — who owns what, resolved.
 *
 * The ambient channel routes events; this decides what the shared surfaces
 * should actually show when more than one subsystem has an opinion. It is kept
 * free of runtime imports so it can be unit tested directly, which matters
 * because both rules below replace last-writer-wins semantics whose failures
 * only showed up in a full session, never in a module test.
 */
import type { RoomState } from './room-response'

/** Who may own the room's accent colour. Higher wins; ties go to the newer claim. */
export const ACCENT_PRIORITY = { proposal: 1, entry: 2 } as const
export type AccentOwner = keyof typeof ACCENT_PRIORITY

export interface AccentClaim {
  color: string
  weight: number
}

export type AccentClaims = Partial<Record<AccentOwner, AccentClaim>>

/**
 * Which accent claim should be showing.
 *
 * The entry cinematic used to call `setRoomAccent` directly, every frame, for
 * ~3.7s — so a proposal arriving in that window was overwritten on the next
 * frame, and entry's release then cleared the proposal's colour early. Both now
 * file claims and this decides, so releasing one hands the surface back rather
 * than blanking it.
 */
export function resolveAccent(claims: AccentClaims): AccentClaim | null {
  let best: AccentClaim | null = null
  let bestRank = -1
  for (const owner of Object.keys(claims) as AccentOwner[]) {
    const claim = claims[owner]
    if (!claim) continue
    const rank = ACCENT_PRIORITY[owner]
    if (rank >= bestRank) {
      bestRank = rank
      best = claim
    }
  }
  return best
}

/**
 * The room shows one thing, but listening and working are independent facts.
 *
 * Collapsing them into a single last-write is why the ring stopped showing that
 * it could hear you the instant a previous command's packet landed — mid
 * sentence. Listening always wins: being heard is the more urgent thing to know.
 */
export function resolveRoomState(listening: boolean, working: boolean): RoomState {
  if (listening) return 'listening'
  if (working) return 'working'
  return 'idle'
}
