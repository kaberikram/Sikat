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
import {
  buildBouncePositionKeyframes,
  buildOrbitPositionKeyframes,
  buildTurnaroundRotationKeyframes,
  type PresetKeyframes,
} from '../animation-presets'
import { buildSpawnMesh } from './spawn-factory'
import { startTween } from './tween'
import { getEaseFn } from '../easing'
import { patchCameraPostSection } from '../post-processing'
import type {
  CommandPacket,
  Target,
  Transition,
  Vec3,
} from './protocol'

const EASE_SAMPLES = 8

export function resolveTarget(target: Target | null | undefined): MotionObject | null {
  if (!target) return null
  const objects = useEditorStore.getState().objects
  if (target.id) {
    const byId = objects.find((o) => o.id === target.id)
    if (byId) return byId
  }
  if (target.name) {
    const needle = target.name.toLowerCase()
    const exact = objects.find((o) => o.name.toLowerCase() === needle)
    if (exact) return exact
    const partial = objects.find((o) => o.name.toLowerCase().includes(needle))
    if (partial) return partial
  }
  return null
}

type VectorProperty = 'position' | 'rotation' | 'scale'

/** Which track a preset writes, and the keyframes it produces.
 *
 * Extracted so the instant-apply path (ANIMATE_OBJECT below) and the runtime's
 * live path-tracing choreography build byte-identical tracks from one place. */
export function presetKeyframes(
  obj: MotionObject,
  preset: 'turnaround' | 'orbit' | 'bounce',
  durationSec: number
): { property: 'position' | 'rotation'; keyframes: PresetKeyframes } {
  if (preset === 'turnaround') {
    return {
      property: 'rotation',
      keyframes: buildTurnaroundRotationKeyframes(obj.rotation, durationSec),
    }
  }
  if (preset === 'orbit') {
    return {
      property: 'position',
      keyframes: buildOrbitPositionKeyframes(obj.position, durationSec),
    }
  }
  return {
    property: 'position',
    keyframes: buildBouncePositionKeyframes(obj.position, durationSec),
  }
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
  const current = hasKeyframes
    ? interpolateKeyframes(obj.keyframes, st.currentTime, property, obj[property])
    : obj[property]
  const to = combine(current, value, mode, property)

  if (transition && hasKeyframes) {
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
  st.updateObject(obj.id, { [property]: to })
  // Mirror the Properties panel: a keyframed property gets a keyframe commit.
  if (hasKeyframes) st.addKeyframe(obj.id, st.currentTime, property, to)
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
    st.updateCamera({ [property]: to })
  }
}

/** Returns a human-readable log line, or throws with a reason. */
export function applyCommandPacket(packet: CommandPacket): string {
  const st = useEditorStore.getState()

  switch (packet.command) {
    case 'SPAWN_OBJECT': {
      const p = packet.payload
      const { mesh, name } = buildSpawnMesh(p)
      st.addObject({
        id: p.id ?? undefined,
        name,
        type: 'mesh',
        mesh,
        position: p.position ?? [0, 0.5, 0],
        rotation: p.rotation ?? [0, 0, 0],
        scale: p.scale ?? [1, 1, 1],
      })
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
      const duration = p.durationSec ?? st.duration
      const { property, keyframes } = presetKeyframes(obj, p.preset, duration)
      st.setObjectPropertyKeyframes(obj.id, property, keyframes)
      st.setTime(0)
      if (!st.isPlaying) st.togglePlay()
      return `${p.preset} on ${obj.name}`
    }

    case 'MOVE_CAMERA': {
      const p = packet.payload
      const cam = st.virtualCamera
      const eye = p.position ?? cam.position
      if (p.position) applyCameraVector('position', p.position, packet.transition)
      let rotation = p.rotation ?? null
      if (!rotation && (p.lookAt || p.lookAtTarget)) {
        const lookTarget = p.lookAt ?? resolveTarget(p.lookAtTarget)?.position
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
          st.updateCamera({ fov: p.fov })
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
        for (const kf of p.keyframes) {
          st.addCameraKeyframe(kf.time, p.property, kf.value)
        }
        return `camera ${p.property} keyframes set`
      }
      const obj = resolveTarget(p.target)
      if (!obj) throw new Error(`target not found: ${p.target.name ?? p.target.id}`)
      if (p.property === 'fov') throw new Error('fov keyframes only apply to the camera')
      st.setObjectPropertyKeyframes(
        obj.id,
        p.property,
        p.keyframes.map((k) => ({ time: k.time, value: k.value }))
      )
      return `${obj.name} ${p.property} keyframes set`
    }

    case 'PLAYBACK': {
      const p = packet.payload
      if (p.action === 'seek') {
        st.setTime(Math.max(0, Math.min(st.duration, p.time ?? 0)))
        return `seek ${p.time ?? 0}s`
      }
      const wantPlaying = p.action === 'play'
      if (st.isPlaying !== wantPlaying) st.togglePlay()
      return wantPlaying ? 'rolling' : 'cut'
    }

    default:
      throw new Error(`unknown command: ${(packet as { command: string }).command}`)
  }
}
