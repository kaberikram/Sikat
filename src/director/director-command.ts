/**
 * Shared director command submit — desktop pod + XR voice finals.
 */
import { beginPendingCommand, releaseCommandPresence } from './agent-runtime'
import { activeAgentSessionId, clearAgentSession } from './agent-tools'
import { markCommandSent } from './latency'
import { tryLocalCommand } from './local-commands'
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
  }
): Promise<SubmitDirectorResult> {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false }

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
    return { ok: true, local: true }
  }

  const socket = getDirectorSocket()
  const commandId = opts?.commandId ?? crypto.randomUUID()
  beginPendingCommand(commandId, { onTimeout: opts?.onNoResponse })
  markCommandSent(commandId)

  const sent = await socket.sendUserCommand(trimmed, {
    forceVision: opts?.forceVision,
    commandId,
  })
  if (sent) {
    log?.('DIRECTOR', trimmed)
    return { ok: true }
  }
  releaseCommandPresence(commandId)
  log?.('DIRECTOR', 'not connected — command dropped', 'error')
  return { ok: false, offline: true }
}
