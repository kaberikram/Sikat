/**
 * Auto-keyframes camera base pose while a take is rolling.
 * Store subscription keeps scene/ renderer-only.
 */
import { useEditorStore } from '../store'
import type { Vec3 } from './protocol'

const SAMPLE_INTERVAL = 0.2
const POS_EPS = 0.005
const ROT_EPS = 0.002
const FOV_EPS = 0.1
const STATIC_GAP = 0.4

interface SampleState {
  lastSampleTime: number
  lastPos: Vec3
  lastRot: Vec3
  lastFov: number
  staticSince: number | null
  wasRolling: boolean
}

function vecDist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function rotDist(a: Vec3, b: Vec3): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
}

function changedEnough(pos: Vec3, rot: Vec3, fov: number, st: SampleState): boolean {
  return (
    vecDist(pos, st.lastPos) > POS_EPS ||
    rotDist(rot, st.lastRot) > ROT_EPS ||
    Math.abs(fov - st.lastFov) > FOV_EPS
  )
}

function snapshotAt(time: number): void {
  useEditorStore.getState().snapshotCameraKeyframes(time)
}

export function startTakeRecorder(): () => void {
  const state: SampleState = {
    lastSampleTime: -Infinity,
    lastPos: [0, 0, 0],
    lastRot: [0, 0, 0],
    lastFov: 50,
    staticSince: null,
    wasRolling: false,
  }

  return useEditorStore.subscribe((st, prev) => {
    const rising = st.isRolling && !prev.isRolling
    const falling = !st.isRolling && prev.isRolling

    if (rising) {
      snapshotAt(st.takeStartTime)
      const vc = st.virtualCamera
      state.lastPos = [...vc.position]
      state.lastRot = [...vc.rotation]
      state.lastFov = vc.fov
      state.lastSampleTime = st.takeStartTime
      state.staticSince = null
      state.wasRolling = true
      return
    }

    if (falling && state.wasRolling) {
      snapshotAt(st.currentTime)
      state.wasRolling = false
      return
    }

    if (!st.isRolling) return

    const vc = st.virtualCamera
    const pos = vc.position
    const rot = vc.rotation
    const fov = vc.fov
    const t = st.currentTime

    if (!changedEnough(pos, rot, fov, state)) {
      if (state.staticSince == null) state.staticSince = t
      return
    }

    if (state.staticSince != null && t - state.staticSince > STATIC_GAP) {
      snapshotAt(state.staticSince)
    }
    state.staticSince = null

    if (t - state.lastSampleTime >= SAMPLE_INTERVAL) {
      snapshotAt(t)
      state.lastSampleTime = t
      state.lastPos = [...pos]
      state.lastRot = [...rot]
      state.lastFov = fov
    }
  })
}
