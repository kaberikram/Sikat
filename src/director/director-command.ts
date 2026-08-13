/**
 * Shared director command submit — desktop pod + XR voice finals.
 */
import { beginPendingCommand, releaseCommandPresence } from './agent-runtime'
import { noteDemoUtterance } from './demo-shoot'
import { newCommandId } from './ids'
import { noteCommandText } from './undo'
import { activeAgentSessionId, clearAgentSession } from './agent-tools'
import { markCommandSent } from './latency'
import { tryLocalCommand } from './local-commands'
import { isCreativeBrief, normalizeUtterance } from './local-grammar'
import { describeImprovisation, improviseSpecs } from './improvise'
import { runLocalPackets } from './local-packets'
import { useEditorStore } from '../store'
import { getDirectorSocket } from './socket'

export type DirectorLogFn = (
  source: string,
  text: string,
  level?: 'info' | 'warn' | 'error'
) => void

export interface SubmitDirectorResult {
  ok: boolean
  offline?: boolean
  local?: boolean
  /** The crew answered from the local vocabulary rather than a server plan. */
  improvised?: boolean
}

/**
 * Commands the local crew has already answered.
 *
 * Three paths can reach the improviser for the same utterance — the link being
 * down, the budget expiring, and a late `miss` from a server that finally
 * answered with nothing. On a slow link two of them can fire for one command,
 * and improvising twice authors a second take over the first.
 */
const improvised = new Set<string>()

/**
 * Answer from the local vocabulary, against whatever is actually on set.
 *
 * Used in two places, and the distinction matters: for an open-ended brief this
 * runs *alongside* the round-trip so the set is never standing still, and the
 * server plan supersedes it through the runtime's barge-in. When the link is
 * down or the crew came back empty, it is the whole answer.
 *
 * Returns false only when there is genuinely nothing to author, or when this
 * command has already been answered locally.
 */
export function improviseNow(
  text: string,
  log?: DirectorLogFn,
  commandId?: string | null
): boolean {
  if (commandId) {
    if (improvised.has(commandId)) return false
    improvised.add(commandId)
    if (improvised.size > 50) {
      const oldest = improvised.values().next().value
      if (oldest) improvised.delete(oldest)
    }
  }
  const objects = useEditorStore.getState().objects.map((o) => ({
    id: o.id,
    name: o.name,
    position: o.position,
  }))
  const specs = improviseSpecs(objects, text)
  if (specs.length === 0) return false
  runLocalPackets(text, specs)
  if (specs.some((spec) => spec.body.command === 'SET_KEYFRAMES')) {
    // Roll it, so the take plays rather than sitting authored on the timeline.
    const st = useEditorStore.getState()
    st.setTime(0)
    if (!st.isPlaying) st.togglePlay()
  }
  log?.('AssetAnimator', describeImprovisation(specs))
  return true
}

export async function submitDirectorCommand(
  text: string,
  opts?: {
    forceVision?: boolean
    commandId?: string
    log?: DirectorLogFn
    onNoResponse?: () => void
    /** Point + speak: the object the director is physically aiming at. */
    targetHint?: { id: string; name: string }
  }
): Promise<SubmitDirectorResult> {
  // One normalization for both paths — the local grammar and the server's
  // parser should never see a different string for the same spoken cue.
  const trimmed = normalizeUtterance(text)
  if (!trimmed) return { ok: false }

  // Advance the SET DAY shot list on any matching cue, whichever path handles it.
  noteDemoUtterance(trimmed)

  const log = opts?.log
  const local = tryLocalCommand(trimmed)
  if (local.handled) {
    // "cut"/"stop" are swallowed locally — also stop any in-flight SceneAgent
    // loop, which otherwise never hears about it (its cancel rides user_command).
    const agentSession = activeAgentSessionId()
    if (agentSession) {
      getDirectorSocket().sendAgentAbort(agentSession)
      clearAgentSession(agentSession)
    }
    log?.('DIRECTOR', trimmed)
    if (local.message) log?.('SYSTEM', local.message)
    if (local.resubmit) {
      // Suggestion accepted — run the suggested command through the full pipeline.
      return submitDirectorCommand(local.resubmit, opts)
    }
    return { ok: true, local: true }
  }

  const socket = getDirectorSocket()
  const commandId = opts?.commandId ?? newCommandId()
  noteCommandText(commandId, trimmed)
  // Echo the director before anything else touches the wire. A vision command
  // awaits a viewfinder JPEG inside `sendUserCommand`, and logging after that
  // meant your own words appeared *after* the crew's answer to them.
  log?.('DIRECTOR', trimmed)

  // An open-ended brief gets a real take immediately, so the set is never
  // standing still while the round-trip happens. It still goes to the crew
  // below, and the plan supersedes this through the runtime's barge-in.
  // Tagged with the commandId so the dead-link path below doesn't author a
  // second take over this one.
  let answered = isCreativeBrief(trimmed) && improviseNow(trimmed, log, commandId)

  beginPendingCommand(commandId, {
    onTimeout: () => {
      // The crew went quiet. Standing still is the one answer that reads as
      // broken, so the set answers from the local vocabulary instead. A late
      // plan still supersedes this the moment it lands.
      improviseNow(trimmed, log, commandId)
      opts?.onNoResponse?.()
    },
  })
  markCommandSent(commandId)

  const { delivery } = await socket.sendUserCommand(trimmed, {
    forceVision: opts?.forceVision,
    commandId,
    targetHint: opts?.targetHint,
  })
  if (delivery === 'sent') return { ok: true }

  // The link is down or absent. Either way the director said something and the
  // set must answer — the crew improvises now, and a held command supersedes it
  // through the runtime's barge-in if the link comes back in time.
  releaseCommandPresence(commandId)
  answered = improviseNow(trimmed, log, commandId) || answered
  if (delivery === 'held') {
    log?.('SYSTEM', 'link lost — holding that until the crew is back', 'warn')
  }
  return { ok: answered, offline: true, improvised: answered }
}
