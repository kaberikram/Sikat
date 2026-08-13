/**
 * Shared director command submit — desktop pod + XR voice finals.
 *
 * Two tiers, and the split is the point. **Reflexes** (transport, undo,
 * overlays, session cues, SET DAY) are answered locally and instantly; a
 * round-trip on "cut" would feel broken. **Everything else goes to the crew**
 * whenever the link is up, because a deterministic grammar returning the same
 * canned rig for "golden hour" every time is what makes the set feel like a
 * lookup table rather than a room with people in it.
 *
 * With no link, the offline grammar answers what it recognises and the rest is
 * an honest miss. Nothing guesses.
 */
import { beginPendingCommand, releaseCommandPresence } from './agent-runtime'
import { noteDemoUtterance } from './demo-shoot'
import { newCommandId } from './ids'
import { noteCommandText } from './undo'
import { activeAgentSessionId, clearAgentSession } from './agent-tools'
import { markCommandSent } from './latency'
import { tryLocalCommand } from './local-commands'
import { normalizeUtterance } from './local-grammar'
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
  const socket = getDirectorSocket()
  // The crew gets first refusal on anything that isn't a reflex. The offline
  // grammar only runs when there is nobody to ask.
  const local = tryLocalCommand(trimmed, { allowSceneGrammar: socket.status !== 'open' })
  if (local.handled) {
    // "cut"/"stop" are swallowed locally — also stop any in-flight SceneAgent
    // loop, which otherwise never hears about it (its cancel rides user_command).
    const agentSession = activeAgentSessionId()
    if (agentSession) {
      socket.sendAgentAbort(agentSession)
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

  const commandId = opts?.commandId ?? newCommandId()
  noteCommandText(commandId, trimmed)
  // Echo the director before anything else touches the wire. A vision command
  // awaits a viewfinder JPEG inside `sendUserCommand`, and logging after that
  // meant your own words appeared after the crew's answer to them.
  log?.('DIRECTOR', trimmed)

  beginPendingCommand(commandId, { onTimeout: opts?.onNoResponse })
  markCommandSent(commandId)

  const { delivery } = await socket.sendUserCommand(trimmed, {
    forceVision: opts?.forceVision,
    commandId,
    targetHint: opts?.targetHint,
  })
  if (delivery === 'sent') return { ok: true }

  // Nobody to ask, and the offline grammar already declined above. Say so
  // rather than inventing something — a canned guess costs more trust than an
  // honest miss.
  releaseCommandPresence(commandId)
  if (delivery === 'held') {
    log?.('SYSTEM', 'link lost — holding that until the crew is back', 'warn')
  } else {
    log?.('SYSTEM', 'no crew on the line — that one needs the agent server', 'warn')
  }
  return { ok: false, offline: true }
}
