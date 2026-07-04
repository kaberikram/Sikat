import { useEditorStore, type VirtualCamera } from '../store'
import type { Vec3 } from './protocol'

export interface LiveCameraPose {
  position?: Vec3
  rotation?: Vec3
  fov?: number
}

/** Single store write for live camera pose — XR/telemetry/fly-controls join point. */
export function applyLiveCameraPose(pose: LiveCameraPose): void {
  const patch: Partial<VirtualCamera> = {}
  if (pose.position) patch.position = pose.position
  if (pose.rotation) patch.rotation = pose.rotation
  if (pose.fov != null) patch.fov = pose.fov
  if (Object.keys(patch).length > 0) useEditorStore.getState().updateCamera(patch)
}
