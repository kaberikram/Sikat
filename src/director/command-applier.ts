/**
 * Applies agent CommandPackets to the editor.
 *
 * Everything is a Zustand store write — Scene.tsx re-applies store state every
 * frame, so mutations become visible next frame with no direct renderer access.
 *
 * Tween-vs-timeline policy (keyframes override base transforms in
 * keyframe-interpolation.ts): if the target property already has keyframes, a
 * transitioned move is AUTHORED AS KEYFRAMES (easing sampled into segments,
 * since track interpolation is linear); otherwise the base value is tweened.
 */
import * as THREE from 'three'
import {
  useEditorStore,
  VIRTUAL_CAMERA_ID,
  type MotionObject,
} from '../store'
import { interpolateKeyframes } from '../keyframe-interpolation'
import { motionKeyframes, defaultMotionDuration, resolveMotionId, type MotionParams } from '../motion-synth'
import { buildBounceScaleKeyframes, DEFAULT_BOUNCE_DECAY } from '../animation-presets'
import {
  canCompositeOntoPath,
  compositeMotionOntoPath,
  existingPositionPath,
} from '../motion-composite'
import { buildSpawnMesh } from './spawn-factory'
import { callStoreAction } from './store-action-bridge'
import { spawnPop } from './sound'
import { startTween, cancelTween, retargetTween } from './tween'
import { getEaseFn } from '../easing'
import { patchCameraPostSection } from '../post-processing'
import { applyLiveCameraPose } from './camera-pose'
import type {
  CommandPacket,
  CommandCancelMessage,
  Target,
  Transition,
  Vec3,
} from './protocol'

const EASE_SAMPLES = 24

const activeClips = new Map<string, () => void>()

function registerClipCancel(commandId: string | null | undefined, cancel: () => void): void {
  if (!commandId) return
  activeClips.set(commandId, cancel)
}

function beginClipPlayback(
  clipEnd: number,
  repeat: boolean,
  commandId: string | null | undefined,
  objectId: string | null
): void {
  const st = useEditorStore.getState()
  st.setTime(0)
  st.setClipLoopEnd(clipEnd)
  if (repeat) {
    st.setPlayOnceEnd(null)
    st.setPlaybackLoop(true)
  } else {
    st.setPlayOnceEnd(clipEnd)
    st.setPlaybackLoop(false)
  }
  if (!st.isPlaying) st.togglePlay()

  registerClipCancel(commandId, () => {
    const state = useEditorStore.getState()
    if (state.isPlaying) state.togglePlay()
    state.setPlayOnceEnd(null)
    state.setPlaybackLoop(false)
    if (objectId) {
      const obj = state.objects.find((o) => o.id === objectId)
      if (obj) {
        const pos = interpolateKeyframes(
          obj.keyframes,
          state.currentTime,
          'position',
          obj.position
        )
        state.updateObject(objectId, { position: pos })
        state.addKeyframe(objectId, state.currentTime, 'position', pos)
      }
    }
    if (commandId) activeClips.delete(commandId)
  })
}

export function cancelCommandPacket(msg: CommandCancelMessage): void {
  const clipCancel = activeClips.get(msg.commandId)
  if (clipCancel) {
    clipCancel()
    return
  }
  const obj = msg.target ? resolveTarget(msg.target) : null
  if (!obj) return
  cancelTween(`${obj.id}:position`)
  cancelTween(`${obj.id}:rotation`)
  cancelTween(`${obj.id}:scale`)
}

export function retargetObjectTween(
  objectId: string,
  property: VectorProperty,
  newTo: Vec3,
  durationSec?: number
): boolean {
  return retargetTween(`${objectId}:${property}`, [...newTo], durationSec)
}

export function resolveTarget(target: Target | null | undefined): MotionObject | null {
  if (!target) return null
  const objects = useEditorStore.getState().objects
  if (target.id) {
    const byId = objects.find((o) => o.id === target.id)
    if (byId) return byId
  }
  if (target.name) {
    const needle = target.name.toLowerCase()
    if (needle === 'ball' || needle === 'the ball') {
      const ballLike = objects.find((o) => {
        const n = o.name.toLowerCase()
        return n.includes('sphere') || n.includes('ball') || n.includes('orb')
      })
      if (ballLike) return ballLike
    }
    const exact = objects.find((o) => o.name.toLowerCase() === needle)
    if (exact) return exact
    const partial = objects.find((o) => o.name.toLowerCase().includes(needle))
    if (partial) return partial
  }
  return null
}

type VectorProperty = 'position' | 'rotation' | 'scale'

/** @deprecated use motionKeyframes from motion-synth.ts */
export function presetKeyframes(
  obj: MotionObject,
  preset: 'turnaround' | 'orbit' | 'bounce',
  durationSec: number,
  stage: { center: Vec3; radius: number } = { center: [0, 0, 0], radius: 1 }
): { property: 'position' | 'rotation' | 'scale'; keyframes: ReturnType<typeof motionKeyframes>['keyframes'] } {
  const track = motionKeyframes(
    obj.position,
    obj.rotation,
    obj.scale,
    preset,
    durationSec,
    {},
    stage
  )
  return { property: track.property, keyframes: track.keyframes }
}

function combine(base: Vec3, value: Vec3, mode: 'absolute' | 'relative', property: VectorProperty): Vec3 {
  if (mode === 'absolute') return value
  if (property === 'scale') return [base[0] * value[0], base[1] * value[1], base[2] * value[2]]
  return [base[0] + value[0], base[1] + value[1], base[2] + value[2]]
}

/** Bake an eased move into linear keyframe segments starting at currentTime. */
function bakeEasedKeyframes(
  obj: MotionObject,
  property: VectorProperty,
  to: Vec3,
  transition: Transition
) {
  const st = useEditorStore.getState()
  const t0 = st.currentTime
  const from = interpolateKeyframes(obj.keyframes, t0, property, obj[property])
  const ease = getEaseFn(transition.easing)
  for (let i = 0; i <= EASE_SAMPLES; i++) {
    const alpha = i / EASE_SAMPLES
    const eased = ease(alpha)
    const value: Vec3 = [
      from[0] + (to[0] - from[0]) * eased,
      from[1] + (to[1] - from[1]) * eased,
      from[2] + (to[2] - from[2]) * eased,
    ]
    st.addKeyframe(obj.id, t0 + alpha * transition.durationSec, property, value)
  }
}

function applyObjectVector(
  obj: MotionObject,
  property: VectorProperty,
  value: Vec3,
  mode: 'absolute' | 'relative',
  transition: Transition | null | undefined
) {
  const st = useEditorStore.getState()
  const hasKeyframes = obj.keyframes.some((k) => k.property === property)
  const isRolling = st.isRolling
  const current = hasKeyframes
    ? interpolateKeyframes(obj.keyframes, st.currentTime, property, obj[property])
    : obj[property]
  const to = combine(current, value, mode, property)

  if (transition && (hasKeyframes || isRolling)) {
    bakeEasedKeyframes(obj, property, to, transition)
    return
  }
  if (transition) {
    startTween({
      key: `${obj.id}:${property}`,
      from: [...current],
      to: [...to],
      durationSec: transition.durationSec,
      easing: transition.easing,
      set: (v) => useEditorStore.getState().updateObject(obj.id, { [property]: v as Vec3 }),
    })
    return
  }
  if (isRolling) {
    const tAnchor = Math.max(0, st.currentTime - 0.001)
    st.addKeyframe(obj.id, tAnchor, property, current)
  }
  st.updateObject(obj.id, { [property]: to })
  if (hasKeyframes || isRolling) st.addKeyframe(obj.id, st.currentTime, property, to)
}

function resolveLookAtPosition(
  lookAt: Vec3 | null | undefined,
  lookAtTarget: Target | null | undefined,
  st: ReturnType<typeof useEditorStore.getState>
): Vec3 | null {
  if (lookAt) return lookAt
  if (!lookAtTarget) return null
  const name = lookAtTarget.name?.toLowerCase()
  if (name === 'stage') return st.stage.position
  const obj = resolveTarget(lookAtTarget)
  if (!obj) return null
  return interpolateKeyframes(obj.keyframes, st.currentTime, 'position', obj.position)
}

function lookAtToEuler(eye: Vec3, targetPos: Vec3): Vec3 {
  const m = new THREE.Matrix4()
  m.lookAt(new THREE.Vector3(...eye), new THREE.Vector3(...targetPos), new THREE.Vector3(0, 1, 0))
  const euler = new THREE.Euler().setFromRotationMatrix(m)
  return [euler.x, euler.y, euler.z]
}

function applyCameraVector(
  property: 'position' | 'rotation',
  to: Vec3,
  transition: Transition | null | undefined
) {
  const st = useEditorStore.getState()
  if (transition) {
    startTween({
      key: `${VIRTUAL_CAMERA_ID}:${property}`,
      from: [...st.virtualCamera[property]],
      to: [...to],
      durationSec: transition.durationSec,
      easing: transition.easing,
      set: (v) => useEditorStore.getState().updateCamera({ [property]: v as Vec3 }),
    })
  } else {
    applyLiveCameraPose({ [property]: to })
  }
}

/** Returns a human-readable log line, or throws with a reason. */
export function applyCommandPacket(packet: CommandPacket): string {
  const st = useEditorStore.getState()
  const isRefinement = packet.refinement === true

  switch (packet.command) {
    case 'SPAWN_OBJECT': {
      const p = packet.payload
      const { mesh, name } = buildSpawnMesh(p)
      const stage = st.stage
      const spawnPos: Vec3 = p.position ?? [
        stage.position[0],
        stage.position[1] + 0.5,
        stage.position[2],
      ]
      const targetScale: Vec3 = p.scale ?? [1, 1, 1]
      st.addObject({
        id: p.id ?? undefined,
        name,
        type: 'mesh',
        mesh,
        position: spawnPos,
        rotation: p.rotation ?? [0, 0, 0],
        scale: targetScale,
      })
      // Entrance pop: new props scale in instead of blinking into existence.
      spawnPop()
      const spawned = useEditorStore.getState().objects.find((o) => o.mesh === mesh)
      if (spawned) {
        useEditorStore.getState().updateObject(spawned.id, {
          scale: [targetScale[0] * 0.01, targetScale[1] * 0.01, targetScale[2] * 0.01],
        })
        startTween({
          key: `${spawned.id}:scale`,
          from: [targetScale[0] * 0.01, targetScale[1] * 0.01, targetScale[2] * 0.01],
          to: [...targetScale],
          durationSec: 0.35,
          easing: 'easeOut',
          set: (v) => useEditorStore.getState().updateObject(spawned.id, { scale: v as Vec3 }),
        })
      }
      return `spawned ${name}`
    }

    case 'REMOVE_OBJECT': {
      const obj = resolveTarget(packet.payload.target)
      if (!obj) throw new Error(`target not found: ${packet.payload.target.name ?? packet.payload.target.id}`)
      st.removeObject(obj.id)
      return `removed ${obj.name}`
    }

    case 'TRANSFORM_OBJECT': {
      const p = packet.payload
      const obj = resolveTarget(p.target)
      if (!obj) throw new Error(`target not found: ${p.target.name ?? p.target.id}`)
      if (p.position) applyObjectVector(obj, 'position', p.position, p.mode, packet.transition)
      if (p.rotation) applyObjectVector(obj, 'rotation', p.rotation, p.mode, packet.transition)
      if (p.scale) applyObjectVector(obj, 'scale', p.scale, p.mode, packet.transition)
      return `transformed ${obj.name}`
    }

    case 'ANIMATE_OBJECT': {
      const p = packet.payload
      const obj = resolveTarget(p.target)
      if (!obj) throw new Error(`target not found: ${p.target.name ?? p.target.id}`)
      const motion = p.motion ?? p.preset ?? 'bounce'
      const params = (p.params ?? {}) as MotionParams
      const stage = { center: st.stage.position, radius: st.stage.radius }
      const existingPath = existingPositionPath(obj.keyframes)
      const useComposite = canCompositeOntoPath(motion, existingPath, st.stage.radius)
      const pathDuration = existingPath[existingPath.length - 1]?.time
      const duration =
        p.durationSec ??
        (useComposite && pathDuration != null && pathDuration > 0
          ? pathDuration
          : defaultMotionDuration(motion, params))

      let property: 'position' | 'rotation' | 'scale'
      let keyframes: ReturnType<typeof motionKeyframes>['keyframes']

      if (useComposite) {
        property = 'position'
        keyframes = compositeMotionOntoPath(existingPath, motion, {
          ...params,
          hops: params.hops ?? Math.max(2, Math.round(duration / 0.45)),
        })
      } else {
        const track = motionKeyframes(
          obj.position,
          obj.rotation,
          obj.scale,
          motion,
          duration,
          params,
          stage
        )
        property = track.property
        keyframes = track.keyframes
      }

      const clipEnd = keyframes[keyframes.length - 1]?.time ?? duration
      const motionId = resolveMotionId(motion)
      if (isRefinement) {
        const fromTime = st.currentTime
        st.mergeObjectPropertyKeyframes(obj.id, property, keyframes, fromTime)
        if (motionId === 'bounce') {
          const scaleKeys = buildBounceScaleKeyframes(
            obj.scale,
            duration,
            params.hops ?? 2,
            params.decay ?? DEFAULT_BOUNCE_DECAY,
            params.flat ?? 0.55
          )
          st.mergeObjectPropertyKeyframes(obj.id, 'scale', scaleKeys, fromTime)
        }
        if (clipEnd > fromTime) beginClipPlayback(clipEnd, p.repeat === true, packet.commandId, obj.id)
      } else {
        st.setObjectPropertyKeyframes(obj.id, property, keyframes)
        if (motionId === 'bounce') {
          const scaleKeys = buildBounceScaleKeyframes(
            obj.scale,
            duration,
            params.hops ?? 2,
            params.decay ?? DEFAULT_BOUNCE_DECAY,
            params.flat ?? 0.55
          )
          st.setObjectPropertyKeyframes(obj.id, 'scale', scaleKeys)
        }
        beginClipPlayback(clipEnd, p.repeat === true, packet.commandId, obj.id)
      }
      const mode = useComposite ? `${motion} along path` : motion
      const suffix = isRefinement ? ' (refined)' : ''
      return `${mode} on ${obj.name} (${duration.toFixed(1)}s${p.repeat ? ', loop' : ''})${suffix}`
    }

    case 'MOVE_CAMERA': {
      const p = packet.payload
      const cam = st.virtualCamera
      const eye = p.position ?? cam.position
      if (p.position) applyCameraVector('position', p.position, packet.transition)
      let rotation = p.rotation ?? null
      if (!rotation && (p.lookAt || p.lookAtTarget)) {
        const lookTarget = resolveLookAtPosition(p.lookAt, p.lookAtTarget, st)
        if (lookTarget) rotation = lookAtToEuler(eye, lookTarget)
      }
      if (rotation) applyCameraVector('rotation', rotation, packet.transition)
      if (p.fov != null) {
        if (packet.transition) {
          startTween({
            key: `${VIRTUAL_CAMERA_ID}:fov`,
            from: [cam.fov],
            to: [p.fov],
            durationSec: packet.transition.durationSec,
            easing: packet.transition.easing,
            set: (v) => useEditorStore.getState().updateCamera({ fov: v[0] }),
          })
        } else {
          applyLiveCameraPose({ fov: p.fov })
        }
      }
      return 'camera updated'
    }

    case 'UPDATE_LIGHTS': {
      const p = packet.payload
      st.updateLighting({
        ambient: p.ambient
          ? {
              ...(p.ambient.color != null ? { color: p.ambient.color } : {}),
              ...(p.ambient.intensity != null ? { intensity: p.ambient.intensity } : {}),
            }
          : undefined,
        key: p.key
          ? {
              ...(p.key.color != null ? { color: p.key.color } : {}),
              ...(p.key.intensity != null ? { intensity: p.key.intensity } : {}),
              ...(p.key.position != null ? { position: p.key.position } : {}),
            }
          : undefined,
        background: p.background ?? undefined,
      })
      return 'lights updated'
    }

    case 'SET_MATERIAL': {
      const p = packet.payload
      const obj = resolveTarget(p.target)
      if (!obj) throw new Error(`target not found: ${p.target.name ?? p.target.id}`)
      st.setObjectMaterial(obj.id, {
        ...(p.color != null ? { color: p.color } : {}),
        ...(p.emissive != null ? { emissive: p.emissive } : {}),
        ...(p.emissiveIntensity != null ? { emissiveIntensity: p.emissiveIntensity } : {}),
        ...(p.opacity != null ? { opacity: p.opacity } : {}),
      })
      return `material on ${obj.name}`
    }

    case 'UPDATE_FX': {
      const { section, patch } = packet.payload
      const vc = useEditorStore.getState().virtualCamera
      const cleaned = Object.fromEntries(
        Object.entries(patch).filter(([, v]) => v !== null && v !== undefined)
      )
      st.updateCamera(patchCameraPostSection(vc, section, cleaned))
      return `${section} fx updated`
    }

    case 'SET_KEYFRAMES': {
      const p = packet.payload
      if (!p.target) {
        if (p.property === 'scale') {
          console.warn('SET_KEYFRAMES: camera scale keyframes ignored')
          return 'camera scale keyframes skipped'
        }
        st.setCameraPropertyKeyframes(
          p.property,
          p.keyframes.map((keyframe) => ({ time: keyframe.time, value: keyframe.value }))
        )
        return `camera ${p.property} keyframes set`
      }
      const obj = resolveTarget(p.target)
      if (!obj) throw new Error(`target not found: ${p.target.name ?? p.target.id}`)
      if (p.property === 'fov') throw new Error('fov keyframes only apply to the camera')
      const mapped = p.keyframes.map((k) => ({ time: k.time, value: k.value }))
      if (isRefinement) {
        st.mergeObjectPropertyKeyframes(obj.id, p.property, mapped, st.currentTime)
      } else {
        st.setObjectPropertyKeyframes(obj.id, p.property, mapped)
      }
      const last = p.keyframes[p.keyframes.length - 1]?.time
      if (last != null && !isRefinement) beginClipPlayback(last, false, packet.commandId, obj.id)
      return `${obj.name} ${p.property} keyframes set${isRefinement ? ' (refined)' : ''}`
    }

    case 'PLAYBACK': {
      const p = packet.payload
      if (p.action === 'record') {
        st.startTake()
        const n = useEditorStore.getState().takeNumber
        return `rolling — take ${n}`
      }
      if (p.action === 'cut') {
        if (st.isRolling) {
          st.endTake()
          return 'cut'
        }
        if (st.isPlaying) st.togglePlay()
        return 'cut'
      }
      if (p.action === 'seek') {
        st.setTime(Math.max(0, Math.min(st.duration, p.time ?? 0)))
        return `seek ${p.time ?? 0}s`
      }
      if (p.action === 'loop_on') {
        st.setPlayOnceEnd(null)
        st.setPlaybackLoop(true)
        if (!st.isPlaying) st.togglePlay()
        return 'loop on'
      }
      if (p.action === 'loop_off') {
        st.setPlaybackLoop(false)
        st.setClipLoopEnd(null)
        return 'loop off'
      }
      const wantPlaying = p.action === 'play'
      if (st.isPlaying !== wantPlaying) st.togglePlay()
      return wantPlaying ? 'preview play' : 'hold'
    }

    case 'CALL_STORE_ACTION': {
      const p = packet.payload
      return callStoreAction(p.action, p.args)
    }

    default:
      throw new Error(`unknown command: ${(packet as { command: string }).command}`)
  }
}
