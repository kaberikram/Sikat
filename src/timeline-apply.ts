import * as THREE from 'three'
import { interpolateKeyframes } from './keyframe-interpolation'
import type { MotionObject, VirtualCamera } from './store'

export function applyVirtualCameraAtTime(
  t: number,
  vc: VirtualCamera,
  threeCam: THREE.PerspectiveCamera
) {
  const pos = interpolateKeyframes(vc.keyframes, t, 'position', vc.position)
  const rot = interpolateKeyframes(vc.keyframes, t, 'rotation', vc.rotation)
  const fovT = interpolateKeyframes(vc.keyframes, t, 'fov', [vc.fov, 0, 0])
  threeCam.position.set(...pos)
  threeCam.rotation.set(...rot)
  threeCam.fov = fovT[0]
  threeCam.updateProjectionMatrix()
}

export function applyObjectTransformAtTime(t: number, obj: MotionObject) {
  if (!obj.mesh) return
  const pos = interpolateKeyframes(obj.keyframes, t, 'position', obj.position)
  const rot = interpolateKeyframes(obj.keyframes, t, 'rotation', obj.rotation)
  const sca = interpolateKeyframes(obj.keyframes, t, 'scale', obj.scale)
  obj.mesh.position.set(...pos)
  obj.mesh.rotation.set(...rot)
  obj.mesh.scale.set(...sca)
}
