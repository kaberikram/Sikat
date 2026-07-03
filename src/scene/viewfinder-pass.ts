import * as THREE from 'three'
import { renderViewfinderFrame } from '../pip-composer'
import { applyObjectTransformAtTime, applyVirtualCameraAtTime } from '../timeline-apply'
import {
  applyViewfinderMeshEffects,
  stripViewfinderObjectEffects,
} from '../viewfinder-mesh-fx'
import type { MotionObject, PostProcessingStack, VirtualCamera } from '../store'
import type { createViewfinderComposer } from '../pip-composer'

type ViewfinderComposer = ReturnType<typeof createViewfinderComposer>

interface ViewfinderPassContext {
  objects: MotionObject[]
  stack: PostProcessingStack
  pipRenderer: THREE.WebGLRenderer
  scene: THREE.Scene
  virtCamera: THREE.PerspectiveCamera
  viewfinder: ViewfinderComposer
  delta: number
  t: number
  vcData: VirtualCamera
  isObjectGizmoActive: (obj: MotionObject) => boolean
  skipCameraApply: boolean
}

export function renderViewfinderPass(ctx: ViewfinderPassContext) {
  const {
    objects,
    stack,
    pipRenderer,
    scene,
    virtCamera,
    viewfinder,
    delta,
    t,
    vcData,
    isObjectGizmoActive,
    skipCameraApply,
  } = ctx

  stripViewfinderObjectEffects(objects)
  applyViewfinderMeshEffects(objects, stack)

  const pipW = pipRenderer.domElement.clientWidth
  const pipH = pipRenderer.domElement.clientHeight
  if (pipW > 0 && pipH > 0) {
    renderViewfinderFrame(stack, pipRenderer, scene, virtCamera, viewfinder, delta)
  }

  stripViewfinderObjectEffects(objects)
  for (const obj of objects) {
    if (!obj.mesh || isObjectGizmoActive(obj)) continue
    applyObjectTransformAtTime(t, obj)
  }
  if (!skipCameraApply) applyVirtualCameraAtTime(t, vcData, virtCamera)
}

export function renderViewfinderExportFrame(
  objects: MotionObject[],
  stack: PostProcessingStack,
  exportRenderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  virtCamera: THREE.PerspectiveCamera,
  viewfinder: ViewfinderComposer,
  t: number,
  vcData: VirtualCamera
) {
  stripViewfinderObjectEffects(objects)
  applyViewfinderMeshEffects(objects, stack)
  renderViewfinderFrame(stack, exportRenderer, scene, virtCamera, viewfinder, 0)
  stripViewfinderObjectEffects(objects)
  for (const obj of objects) applyObjectTransformAtTime(t, obj)
  applyVirtualCameraAtTime(t, vcData, virtCamera)
}
