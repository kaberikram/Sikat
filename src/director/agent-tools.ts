/**
 * Client executor for SceneAgent tool calls (agent_tool_use round trips).
 *
 * Unlike the legacy packet stream, agent-mode packets apply IMMEDIATELY —
 * the server loop needs deterministic apply-then-observe, not the paced
 * cursor theater. Every reply carries a fresh full snapshot so the model
 * can verify its work; frames only ship when it asks (capture_frame).
 */
import { applyCommandPacket } from './command-applier'
import { markAgentActive } from './agent-runtime'
import { callStoreAction } from './store-action-bridge'
import { buildFullSnapshot } from './scene-state-sync'
import { captureViewfinderFrame } from './viewfinder-capture'
import type { DirectorSocket } from './socket'
import type {
  AgentToolUseMessage,
  CommandPacket,
  SceneFrame,
} from './protocol'

let agentSessionCommandId: string | null = null

/** True while a SceneAgent loop is driving this client (used to forward
 *  locally-handled "cut"/"stop" as agent_abort). */
export function activeAgentSessionId(): string | null {
  return agentSessionCommandId
}

export function clearAgentSession(commandId?: string): void {
  if (!commandId || agentSessionCommandId === commandId) {
    agentSessionCommandId = null
  }
}

async function executeToolUse(
  msg: AgentToolUseMessage
): Promise<{ ok: boolean; results: string[]; frame: SceneFrame | null }> {
  const results: string[] = []
  let ok = true
  let frame: SceneFrame | null = null

  switch (msg.tool) {
    case 'run_commands': {
      const packets = (msg.payload.packets ?? []) as CommandPacket[]
      for (const packet of packets) {
        try {
          results.push(applyCommandPacket(packet))
        } catch (e) {
          ok = false
          results.push(`ERROR: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      break
    }
    case 'call_store_action': {
      try {
        results.push(
          callStoreAction(
            String(msg.payload.action ?? ''),
            (msg.payload.args ?? []) as unknown[]
          )
        )
      } catch (e) {
        ok = false
        results.push(`ERROR: ${e instanceof Error ? e.message : String(e)}`)
      }
      break
    }
    case 'capture_frame': {
      frame = await captureViewfinderFrame()
      if (!frame) {
        ok = false
        results.push('ERROR: viewfinder frame capture failed')
      }
      break
    }
    case 'get_scene':
      // Snapshot is attached to every reply; nothing extra to do.
      break
  }

  return { ok, results, frame }
}

/** Subscribe once (DirectorPod mount). Returns the unsubscribe. */
export function startAgentToolExecutor(socket: DirectorSocket): () => void {
  return socket.onToolUse((msg) => {
    agentSessionCommandId = msg.commandId
    markAgentActive('Producer', `agent: ${msg.tool}`, msg.commandId)
    void executeToolUse(msg)
      .catch((e) => ({
        ok: false,
        results: [`ERROR: ${e instanceof Error ? e.message : String(e)}`],
        frame: null,
      }))
      .then(({ ok, results, frame }) => {
        socket.sendToolResult({
          type: 'agent_tool_result',
          timestamp: Date.now() / 1000,
          commandId: msg.commandId,
          requestId: msg.requestId,
          ok,
          results,
          frame,
          scene: {
            type: 'scene_state',
            timestamp: Date.now() / 1000,
            ...buildFullSnapshot(),
          },
        })
      })
  })
}
