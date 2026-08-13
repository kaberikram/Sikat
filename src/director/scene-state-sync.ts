/**
 * Streams a debounced scene snapshot to the server so agents can ground
 * parsing in real object names/transforms. Sent on socket open and whenever
 * the relevant slice of the store changes (300 ms debounce).
 */
import * as THREE from 'three'
import { interpolateKeyframes } from '../keyframe-interpolation'
import { useEditorStore, type MotionObject, type PostProcessingStack, type VirtualCamera } from '../store'
import type {
  BoundsSnapshot,
  FxSection,
  FxSummary,
  KeyframeTrack,
  KeyframeTrackFull,
  KeyframeTrackSummary,
  ObjectSnapshot,
  SampledTransform,
  SceneLightingSnapshot,
  SceneSnapshot,
  VirtualCameraSnapshot,
} from './protocol'
import type { DirectorSocket } from './socket'

const DEBOUNCE_MS = 300

const FX_SECTIONS: FxSection[] = ['bloom', 'pixelate', 'cellShading', 'glitch', 'dither']

export function sampleObjectAtTime(
  obj: Pick<MotionObject, 'position' | 'rotation' | 'scale' | 'keyframes'>,
  currentTime: number
): SampledTransform {
  return {
    position: interpolateKeyframes(obj.keyframes, currentTime, 'position', obj.position),
    rotation: interpolateKeyframes(obj.keyframes, currentTime, 'rotation', obj.rotation),
    scale: interpolateKeyframes(obj.keyframes, currentTime, 'scale', obj.scale),
  }
}

export function sampleVirtualCameraAtTime(
  vc: Pick<VirtualCamera, 'position' | 'rotation' | 'fov' | 'keyframes'>,
  currentTime: number
): { sampled: SampledTransform; sampledFov: number } {
  const fovVec = interpolateKeyframes(vc.keyframes, currentTime, 'fov', [vc.fov, 0, 0])
  return {
    sampled: {
      position: interpolateKeyframes(vc.keyframes, currentTime, 'position', vc.position),
      rotation: interpolateKeyframes(vc.keyframes, currentTime, 'rotation', vc.rotation),
      scale: [1, 1, 1],
    },
    sampledFov: fovVec[0],
  }
}

function buildTrackSummaries(
  keyframes: Array<{ time: number; property: string }>,
  properties: string[]
): KeyframeTrackSummary[] {
  return properties.map((property) => ({
    property: property as KeyframeTrackSummary['property'],
    keyframeCount: keyframes.filter((k) => k.property === property).length,
  }))
}

function isSmallKeyframeSet(kfs: Array<{ property: string }>): boolean {
  return kfs.length <= 24
}

function buildTrackFull(
  keyframes: Array<{ time: number; property: string; value: [number, number, number] }>,
  property: string
): KeyframeTrackFull {
  return {
    property: property as KeyframeTrackFull['property'],
    keyframes: keyframes
      .filter((k) => k.property === property)
      .sort((a, b) => a.time - b.time)
      .map((k) => ({ time: k.time, value: k.value })),
  }
}

function buildFxSummary(stack: PostProcessingStack): FxSummary {
  const enabledSections = FX_SECTIONS.filter((section) => stack[section].enabled)
  return {
    enabledSections,
    bloomStrength: stack.bloom.enabled ? stack.bloom.strength : null,
    ditherLevels: stack.dither.enabled ? stack.dither.levels : null,
  }
}

/** Reused across every object in a snapshot — same reason `attention-field.ts`
 *  keeps a module-scope scratch box rather than allocating one per measurement. */
const scratchBox = new THREE.Box3()

/**
 * World-space bounds from the live mesh.
 *
 * `setFromObject` walks children and honours the current world matrix, so a
 * scaled or animated object measures as it currently stands — which is the
 * whole point, since the crew reasons about where a surface *is* right now.
 * Null for an object with no mesh yet, and for an empty box (a group whose
 * children have not loaded), because reporting a degenerate point as bounds
 * would read as a zero-sized object.
 */
function buildBounds(obj: MotionObject): BoundsSnapshot | null {
  if (!obj.mesh) return null
  scratchBox.setFromObject(obj.mesh)
  if (scratchBox.isEmpty()) return null
  const { min, max } = scratchBox
  const round = (n: number) => Math.round(n * 1000) / 1000
  return {
    min: [round(min.x), round(min.y), round(min.z)],
    max: [round(max.x), round(max.y), round(max.z)],
  }
}

function buildObjectSnapshot(
  obj: MotionObject,
  currentTime: number,
  fullMode: boolean
): ObjectSnapshot {
  const properties = [...new Set(obj.keyframes.map((k) => k.property))]
  const tracks: KeyframeTrack[] = fullMode || isSmallKeyframeSet(obj.keyframes)
    ? properties.map((p) => buildTrackFull(obj.keyframes, p))
    : buildTrackSummaries(obj.keyframes, properties)

  return {
    id: obj.id,
    name: obj.name,
    position: obj.position,
    rotation: obj.rotation,
    scale: obj.scale,
    sampled: sampleObjectAtTime(obj, currentTime),
    keyframedProperties: properties,
    tracks,
    materialOverride: obj.materialOverride ?? null,
    primitive: obj.primitive ?? null,
    bounds: buildBounds(obj),
    motion: obj.motion ?? null,
    motionParams: obj.motionParams ?? null,
    motionLoop: obj.motionLoop ?? null,
  }
}

function buildVirtualCameraSnapshot(
  vc: VirtualCamera,
  currentTime: number,
  fullMode: boolean
): VirtualCameraSnapshot {
  const properties = [...new Set(vc.keyframes.map((k) => k.property))]
  const tracks: KeyframeTrack[] = fullMode || isSmallKeyframeSet(vc.keyframes)
    ? properties.map((p) => buildTrackFull(vc.keyframes, p))
    : buildTrackSummaries(vc.keyframes, properties)
  const { sampled, sampledFov } = sampleVirtualCameraAtTime(vc, currentTime)

  return {
    position: vc.position,
    rotation: vc.rotation,
    fov: vc.fov,
    sampled,
    sampledFov,
    keyframedProperties: properties,
    tracks,
    fx: buildFxSummary(vc.postProcessing),
  }
}

function buildLightingSnapshot(): SceneLightingSnapshot {
  const lighting = useEditorStore.getState().lighting
  return {
    ambient: { color: lighting.ambient.color, intensity: lighting.ambient.intensity },
    key: {
      color: lighting.key.color,
      intensity: lighting.key.intensity,
      position: lighting.key.position,
    },
    background: lighting.background,
  }
}

function buildCoreSnapshot(mode: 'heartbeat' | 'full'): Omit<SceneSnapshot, 'type' | 'timestamp'> {
  const st = useEditorStore.getState()
  const fullMode = mode === 'full'
  return {
    mode,
    currentTime: st.currentTime,
    duration: st.duration,
    isPlaying: st.isPlaying,
    isRolling: st.isRolling,
    playbackLoop: st.playbackLoop,
    clipLoopEnd: st.clipLoopEnd,
    playOnceEnd: st.playOnceEnd,
    takeStartTime: st.takeStartTime,
    selectedId: st.selectedId,
    stage: { position: st.stage.position, radius: st.stage.radius },
    objects: st.objects.map((o) => buildObjectSnapshot(o, st.currentTime, fullMode)),
    virtualCamera: buildVirtualCameraSnapshot(st.virtualCamera, st.currentTime, fullMode),
    lighting: buildLightingSnapshot(),
  }
}

export function buildHeartbeatSnapshot(): Omit<SceneSnapshot, 'type' | 'timestamp'> {
  return buildCoreSnapshot('heartbeat')
}

export function buildFullSnapshot(): Omit<SceneSnapshot, 'type' | 'timestamp'> {
  return buildCoreSnapshot('full')
}

/** @deprecated Use buildHeartbeatSnapshot — kept for any lingering imports. */
export function buildSceneSnapshot(): Omit<SceneSnapshot, 'type' | 'timestamp'> {
  return buildHeartbeatSnapshot()
}

let started = false

export function startSceneStateSync(socket: DirectorSocket): void {
  if (started) return
  started = true

  let lastSignature = ''
  let dirty = false

  const send = () => {
    const snapshot = buildHeartbeatSnapshot()
    const signature = JSON.stringify(snapshot)
    if (signature === lastSignature) return
    if (socket.sendSceneState(snapshot)) lastSignature = signature
  }

  socket.onOpen(() => {
    lastSignature = ''
    send()
  })

  // Dirty-flag + interval instead of a debounce: during playback the store
  // updates every frame, and a self-resetting debounce timer never fired —
  // the server's scene grounding froze whenever the timeline was playing.
  useEditorStore.subscribe(() => {
    dirty = true
  })
  setInterval(() => {
    if (!dirty) return
    dirty = false
    send()
  }, DEBOUNCE_MS)
}

// Debug/smoke-test hook, mirroring `window.__editorStore`. Exposing the built
// snapshot rather than raw meshes lets an E2E run assert on exactly what the
// crew receives — bounds included — instead of recomputing geometry and hoping
// the two agree.
declare global {
  interface Window {
    __sceneSnapshot?: typeof buildHeartbeatSnapshot
  }
}
if (typeof window !== 'undefined') window.__sceneSnapshot = buildHeartbeatSnapshot
