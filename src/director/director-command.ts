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
import { beatsToSpecs, choreograph } from './improvise'
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

  // An open-ended brief gets a real take immediately, from the local motion
  // vocabulary, against whatever is actually on set. It still goes to the crew
  // below — the plan supersedes this through the runtime's barge-in — but the
  // set is never standing still while that round-trip happens, and a slow or
  // failed server degrades to a decent shot instead of an error.
  if (isCreativeBrief(trimmed)) {
    const objects = useEditorStore.getState().objects.map((o) => ({ id: o.id, name: o.name }))
    const beats = choreograph(objects, trimmed)
    runLocalPackets(trimmed, beatsToSpecs(beats))
    // Roll it, so the take plays rather than sitting authored on the timeline.
    const st = useEditorStore.getState()
    st.setTime(0)
    if (!st.isPlaying) st.togglePlay()
    log?.('AssetAnimator', `improvising — ${beats.map((b) => b.motion).join(', ')}`)
  }

  const socket = getDirectorSocket()
  const commandId = opts?.commandId ?? newCommandId()
  noteCommandText(commandId, trimmed)
  beginPendingCommand(commandId, { onTimeout: opts?.onNoResponse })
  markCommandSent(commandId)

  const sent = await socket.sendUserCommand(trimmed, {
    forceVision: opts?.forceVision,
    commandId,
    targetHint: opts?.targetHint,
  })
  if (sent) {
    log?.('DIRECTOR', trimmed)
    return { ok: true }
  }
  releaseCommandPresence(commandId)
  if (socket.everConnected) {
    log?.('DIRECTOR', 'link lost — command dropped, reconnecting…', 'error')
  } else {
    log?.('DIRECTOR', trimmed)
    log?.(
      'SYSTEM',
      'LOCAL CREW didn’t catch that — try “add a red box”, “golden hour”, or “make the sphere bounce”',
      'warn'
    )
  }
  return { ok: false, offline: true }
}
