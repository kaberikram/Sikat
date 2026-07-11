/**
 * Streams a debounced scene snapshot to the server so agents can ground
 * parsing in real object names/transforms. Sent on socket open and whenever
 * the relevant slice of the store changes (300 ms debounce).
 */
import { interpolateKeyframes } from '../keyframe-interpolation'
import { useEditorStore, type MotionObject, type PostProcessingStack, type VirtualCamera } from '../store'
import type {
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
  let timer: ReturnType<typeof setTimeout> | null = null

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

  useEditorStore.subscribe(() => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(send, DEBOUNCE_MS)
  })
}
