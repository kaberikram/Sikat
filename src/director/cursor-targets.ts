/**
 * Derives the 3D point an agent's cursor should fly to for a given packet.
 *
 * Per the architecture, the server sends *semantic* events and the client
 * computes cursor positions — the client is the only side that knows both the
 * live scene transforms (keyframed motion the debounced snapshot can't see) and
 * the exact moment a packet is applied. So the target is resolved here, right
 * before the runtime paces the apply.
 */
import { useEditorStore } from '../store'
import { resolveTarget } from './command-applier'
import { stationFor } from './presence'
import { sampleObjectAtTime } from './scene-state-sync'
import type { CommandPacket, Target, Vec3 } from './protocol'

/** Live world position of a scene object at the current timeline time. */
export function liveTargetPosition(target: Target | { name?: string } | null | undefined): Vec3 | null {
  if (!target) return null
  const obj = resolveTarget(target)
  if (!obj) return null
  return sampleObjectAtTime(obj, useEditorStore.getState().currentTime).position
}

/** Where the cursor addresses this packet. Falls back to the agent's station
 *  for scene-global commands (FX, playback) with no spatial anchor. */
export function packetTargetPosition(packet: CommandPacket): Vec3 {
  const st = useEditorStore.getState()
  const station = stationFor(packet.target_agent)

  switch (packet.command) {
    case 'SPAWN_OBJECT': {
      const stage = useEditorStore.getState().stage
      return packet.payload.position ?? [
        stage.position[0],
        stage.position[1] + 0.5,
        stage.position[2],
      ]
    }

    case 'REMOVE_OBJECT':
    case 'TRANSFORM_OBJECT':
    case 'ANIMATE_OBJECT':
    case 'SET_MATERIAL':
      return liveTargetPosition(packet.payload.target) ?? station

    case 'SET_KEYFRAMES':
      return packet.payload.target
        ? liveTargetPosition(packet.payload.target) ?? station
        : st.virtualCamera.position

    case 'MOVE_CAMERA': {
      const p = packet.payload
      if (p.position) return p.position
      if (p.lookAt) return p.lookAt
      if (p.lookAtTarget) {
        if (p.lookAtTarget.name?.toLowerCase() === 'stage') return st.stage.position
        return liveTargetPosition(p.lookAtTarget) ?? st.virtualCamera.position
      }
      return st.virtualCamera.position
    }

    case 'UPDATE_LIGHTS':
      // If the command explicitly repositions the key light, follow it there;
      // otherwise work from the lighting desk (station). The default rig hangs
      // near the camera plane, so flying to the literal light would put the
      // cursor in the lens — the station keeps it framed above the stage.
      return packet.payload.key?.position ?? station

    case 'UPDATE_FX':
    case 'PLAYBACK':
    default:
      return station
  }
}
