/**
 * Executes LOCAL CREW grammar results: wraps parsed packet specs into real
 * CommandPackets and feeds them through the same agent-runtime pipeline the
 * server uses — cursor theater, per-command undo, and log lines all included.
 */
import { enqueuePacket } from './agent-runtime'
import { newCommandId } from './ids'
import { noteCommandText } from './undo'
import type { LocalPacketSpec } from './local-grammar'
import type { CommandPacket } from './protocol'

export function runLocalPackets(text: string, specs: LocalPacketSpec[]): void {
  const commandId = newCommandId()
  noteCommandText(commandId, text)
  for (const spec of specs) {
    const packet: CommandPacket = {
      ...spec.body,
      timestamp: Date.now() / 1000,
      commandId,
      target_agent: spec.agent,
    } as CommandPacket
    enqueuePacket(packet)
  }
}
