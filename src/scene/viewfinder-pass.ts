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

interface ViewfinderTargetContext {
  objects: MotionObject[]
  stack: PostProcessingStack
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  virtCamera: THREE.PerspectiveCamera
  viewfinder: ViewfinderComposer
  target: THREE.WebGLRenderTarget
  width: number
  height: number
  delta: number
  t: number
  isObjectGizmoActive: (obj: MotionObject) => boolean
  /** Studio clear — never passthrough / null scene.background. */
  clearColor?: string | THREE.Color
}

const scratchRenderSize = new THREE.Vector2()

function restoreObjectTransforms(
  objects: MotionObject[],
  t: number,
  isObjectGizmoActive: (obj: MotionObject) => boolean
): void {
  stripViewfinderObjectEffects(objects)
  for (const obj of objects) {
    if (!obj.mesh || isObjectGizmoActive(obj)) continue
    applyObjectTransformAtTime(t, obj)
  }
}

/** Shared PiP / XR viewfinder draw — same camera, FX stack, and mesh effects. */
export function renderViewfinderToTarget(ctx: ViewfinderTargetContext): void {
  const {
    objects,
    stack,
    renderer,
    scene,
    virtCamera,
    viewfinder,
    target,
    width,
    height,
    delta,
    t,
    isObjectGizmoActive,
    clearColor,
  } = ctx

  if (width <= 0 || height <= 0) return

  stripViewfinderObjectEffects(objects)
  applyViewfinderMeshEffects(objects, stack)

  const prevAspect = virtCamera.aspect
  virtCamera.aspect = width / height
  virtCamera.updateProjectionMatrix()

  scratchRenderSize.set(width, height)
  const dpr = renderer.getPixelRatio()
  const targetW = Math.max(1, Math.floor(width * dpr))
  const targetH = Math.max(1, Math.floor(height * dpr))
  if (target.width !== targetW || target.height !== targetH) {
    target.setSize(targetW, targetH)
  }

  const prevTarget = renderer.getRenderTarget()
  const prevClearColor = new THREE.Color()
  renderer.getClearColor(prevClearColor)
  const prevClearAlpha = renderer.getClearAlpha()
  const prevBg = scene.background
  const studioBg =
    clearColor instanceof THREE.Color
      ? clearColor
      : new THREE.Color(clearColor ?? '#f2f2f2')

  // Three.js swaps to the XR headset camera on every render while presenting —
  // bypass so the viewfinder RT uses virtCamera (controller-tracked).
  const xrWasEnabled = renderer.xr.enabled
  renderer.xr.enabled = false

  // Force opaque studio bg for the film pass (headset may have set background null).
  scene.background = studioBg
  renderer.setRenderTarget(target)
  renderer.setClearColor(studioBg, 1)
  renderer.clear()
  viewfinder.composer.setSize(width, height)
  renderViewfinderFrame(stack, renderer, scene, virtCamera, viewfinder, delta, scratchRenderSize)
  renderer.setRenderTarget(prevTarget)
  renderer.setClearColor(prevClearColor, prevClearAlpha)
  scene.background = prevBg
  renderer.xr.enabled = xrWasEnabled

  virtCamera.aspect = prevAspect
  virtCamera.updateProjectionMatrix()

  restoreObjectTransforms(objects, t, isObjectGizmoActive)
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

  restoreObjectTransforms(objects, t, isObjectGizmoActive)
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
  restoreObjectTransforms(objects, t, () => false)
  applyVirtualCameraAtTime(t, vcData, virtCamera)
}
