/**
 * Shared director command submit — desktop pod + XR voice finals.
 */
import { applyClientIntentGuess, idleGuessedAgent } from './agent-runtime'
import { buildProducerReadback, guessIntent } from './intent-guess'
import { markCommandSent } from './latency'
import { tryLocalCommand } from './local-commands'
import { getDirectorSocket } from './socket'

export type DirectorLogFn = (
  source: string,
  text: string,
  level?: 'info' | 'warn' | 'error'
) => void

const INSTANT_NOTES = [
  'copy',
  'on it',
  'hearing you',
  'rolling on that',
  'got it',
  'standing by',
  'yep',
  'roger',
]

let noteIdx = 0
const recentNotes: string[] = []

function nextInstantNote(): string {
  const fresh = INSTANT_NOTES.filter((n) => !recentNotes.includes(n))
  const pool = fresh.length > 0 ? fresh : INSTANT_NOTES
  const note = pool[noteIdx % pool.length]
  noteIdx += 1
  recentNotes.push(note)
  if (recentNotes.length > 12) recentNotes.shift()
  return note
}

/** True when client has a real set-command signal — not open speech. */
export function hasCommandSignal(text: string): boolean {
  return buildProducerReadback(text) != null || guessIntent(text) != null
}

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
  }
): Promise<SubmitDirectorResult> {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false }

  const log = opts?.log
  const local = tryLocalCommand(trimmed)
  if (local.handled) {
    log?.('DIRECTOR', trimmed)
    if (local.message) log?.('SYSTEM', local.message)
    return { ok: true, local: true }
  }

  const socket = getDirectorSocket()
  const commandId = opts?.commandId ?? crypto.randomUUID()
  const readback = buildProducerReadback(trimmed)
  // Only flash a Producer ACK when we have a real set-command signal —
  // greetings / chitchat wait for the server radio reply.
  if (readback != null) log?.('PRODUCER', readback)
  else if (guessIntent(trimmed) != null) log?.('PRODUCER', nextInstantNote())
  applyClientIntentGuess(trimmed, commandId)
  markCommandSent(commandId)

  const sent = await socket.sendUserCommand(trimmed, {
    forceVision: opts?.forceVision,
    commandId,
  })
  if (sent) {
    log?.('DIRECTOR', trimmed)
    return { ok: true }
  }
  idleGuessedAgent(commandId)
  log?.('DIRECTOR', 'not connected — command dropped', 'error')
  return { ok: false, offline: true }
}
