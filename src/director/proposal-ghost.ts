/**
 * Proposals that stand on the set.
 *
 * The crew's observer notices things unprompted — a washed-out bloom, a hero
 * sitting in the dark, nothing choreographed yet — and offers a fix. That offer
 * used to be a line of text on the slate: `💡 … — say "do it"`. Reading a
 * suggestion is not the same as seeing one.
 *
 * Now a spatial suggestion appears as what it would actually do: a breathing
 * ghost of the outcome, standing where the change would land. Say "do it" and
 * it becomes real. Say nothing and it dissolves. There is no dismiss gesture,
 * because declining shouldn't cost anything — ignoring it *is* declining, and
 * that is the whole argument of the thing in one interaction.
 *
 * Reuses the understanding-ghost machinery wholesale: the suggested command is
 * run through the offline grammar, turned into the same IntentPreviewMessage
 * shape the server sends, and handed to showGhost. No new rendering code.
 */
import { respond } from '../scene/xr/ambient-channel'
import { isGoodMomentToPropose } from '../scene/xr/ambient-sense'
import { clearGhost, showGhost } from './ghost-preview'
import { parseOfflineClauses } from './local-grammar'
import type {
  AgentSuggestionMessage,
  IntentPreviewMessage,
  SpawnObjectPayload,
  Vec3,
} from './protocol'

/** Long enough to notice and answer, short enough that the set isn't haunted. */
const PROPOSAL_TTL_MS = 9000

/** Ghost ids are namespaced so a proposal never collides with a live command. */
const PROPOSAL_ID_PREFIX = 'proposal:'

let liveProposalId: string | null = null
let expiry: ReturnType<typeof setTimeout> | null = null

/**
 * Turn a parsed local packet into the preview shape ghost-preview understands.
 * Only spatial outcomes get a ghost — a light change or an FX tweak has no
 * silhouette to stand in for it, and inventing one would be a lie.
 */
function previewFromCommand(commandId: string, text: string): IntentPreviewMessage | null {
  const specs = parseOfflineClauses(text)
  if (!specs || specs.length === 0) return null

  for (const spec of specs) {
    const body = spec.body
    if (body.command === 'SPAWN_OBJECT') {
      // LocalPacketSpec['body'] is an Omit<> over the packet union, which
      // flattens the discriminant, so `command` doesn't narrow `payload`.
      const payload = body.payload as SpawnObjectPayload
      return {
        type: 'intent_preview',
        timestamp: Date.now(),
        commandId,
        agent: spec.agent,
        note: text,
        confidence: 'grammar',
        action: 'spawn',
        primitive: payload.primitive,
        color: payload.color ?? null,
        position: payload.position ?? null,
      }
    }
    if (body.command === 'TRANSFORM_OBJECT') {
      const payload = body.payload as {
        target?: { name?: string | null } | null
        mode?: 'absolute' | 'relative' | null
        position?: Vec3 | null
        rotation?: Vec3 | null
        scale?: Vec3 | null
      }
      const name = payload.target?.name
      if (!name) continue
      return {
        type: 'intent_preview',
        timestamp: Date.now(),
        commandId,
        agent: spec.agent,
        note: text,
        confidence: 'grammar',
        action: 'transform',
        target: name,
        mode: payload.mode ?? 'relative',
        position: payload.position ?? null,
        rotation: payload.rotation ?? null,
        scale: payload.scale ?? null,
      }
    }
  }
  return null
}

export type ProposalOutcome =
  /** A breathing ghost of the outcome is standing on the set. */
  | 'shown'
  /** Nothing to draw — a relight or an FX tweak. The offer needs words. */
  | 'not-spatial'
  /** The director is mid-move. Say nothing; "do it" still takes it up later. */
  | 'bad-moment'

/**
 * Offer a suggestion as a ghost.
 *
 * The three outcomes are deliberately distinct. `not-spatial` means the set has
 * nothing to show and the caller should fall back to words, because a proposal
 * nobody can perceive is not a proposal. `bad-moment` means it *could* be shown
 * and shouldn't be yet — falling back to words there would be exactly the
 * interruption the gate exists to prevent. The suggestion stays live either
 * way, so "do it" still works.
 */
export function showProposal(msg: AgentSuggestionMessage): ProposalOutcome {
  if (!msg.suggestedCommand) return 'not-spatial'
  const commandId = `${PROPOSAL_ID_PREFIX}${msg.suggestionId}`
  const preview = previewFromCommand(commandId, msg.suggestedCommand)
  if (!preview) return 'not-spatial'

  // Never cut across someone mid-move. The crew's own rate limits keep offers
  // rare; this keeps them well-timed, which is a different problem.
  if (!isGoodMomentToPropose()) return 'bad-moment'

  clearProposal()
  showGhost(preview, { breathe: true, ttlMs: PROPOSAL_TTL_MS })
  liveProposalId = commandId
  // Ignoring it is how you decline, so the offer has to actually expire.
  expiry = setTimeout(() => {
    liveProposalId = null
    expiry = null
    // Ignored into expiry — the ghost dissolves on its own TTL, and the room's
    // attribution goes with it.
    respond({ kind: 'proposalEnded' })
  }, PROPOSAL_TTL_MS)
  return 'shown'
}

export function hasLiveProposal(): boolean {
  return liveProposalId !== null
}

/** Taken up, superseded, or the session ended. */
export function clearProposal(): void {
  if (expiry) {
    clearTimeout(expiry)
    expiry = null
  }
  if (liveProposalId) {
    clearGhost(liveProposalId)
    liveProposalId = null
  }
  // The room stops wearing the proposing member's colour when — and only when —
  // the offer is actually over, so attribution lasts exactly as long as the
  // thing it attributes.
  respond({ kind: 'proposalEnded' })
}
