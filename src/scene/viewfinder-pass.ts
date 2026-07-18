import * as THREE from 'three'
import { renderViewfinderFrame, updateViewfinderComposerFromStack, viewfinderShouldUseComposer } from '../pip-composer'
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
// Per-frame scratch — this pass runs 1-2× every frame; no allocations inside.
const scratchPrevClear = new THREE.Color()
const scratchStudioBg = new THREE.Color()

// ---- fullscreen blit (composer output → render target) ----

/** Cached geometry for a fullscreen quad covering NDC [-1,1]. */
const blitQuad = new THREE.PlaneGeometry(2, 2)
const blitScene = new THREE.Scene()
const blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
let blitMaterial: THREE.MeshBasicMaterial | null = null
let blitMesh: THREE.Mesh | null = null

/**
 * The EffectComposer always renders to its own internal buffers.  When we need
 * the result inside a caller-supplied `WebGLRenderTarget`, we blit the
 * composer's output texture into `target` using a trivial fullscreen quad.
 */
function blitTextureToTarget(
  renderer: THREE.WebGLRenderer,
  source: THREE.Texture,
  target: THREE.WebGLRenderTarget
): void {
  if (!blitMaterial) {
    blitMaterial = new THREE.MeshBasicMaterial({
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    blitMesh = new THREE.Mesh(blitQuad, blitMaterial)
    blitScene.add(blitMesh)
  }
  blitMaterial.map = source
  blitMaterial.needsUpdate = true

  renderer.setRenderTarget(target)
  renderer.render(blitScene, blitCamera)
}

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

  // XR sessions may disable autoClear — save and force it for our pass.
  const prevAutoClear = renderer.autoClear
  const prevAutoClearColor = renderer.autoClearColor
  renderer.autoClear = true
  renderer.autoClearColor = true

  const prevClearColor = scratchPrevClear
  renderer.getClearColor(prevClearColor)
  const prevClearAlpha = renderer.getClearAlpha()
  const prevBg = scene.background
  const studioBg =
    clearColor instanceof THREE.Color
      ? clearColor
      : scratchStudioBg.set(clearColor ?? '#f2f2f2')

  // Three.js swaps to the XR headset camera on every render while presenting —
  // bypass so the viewfinder RT uses virtCamera (controller-tracked).
  const xrWasEnabled = renderer.xr.enabled
  renderer.xr.enabled = false

  // Force opaque studio bg for the film pass (headset may have set background null).
  scene.background = studioBg
  renderer.setRenderTarget(target)
  renderer.setClearColor(studioBg, 1)
  if (viewfinder.composerWidth !== width || viewfinder.composerHeight !== height) {
    viewfinder.composer.setSize(width, height)
    viewfinder.composerWidth = width
    viewfinder.composerHeight = height
  }

  const shouldCompose = viewfinderShouldUseComposer(stack)
  if (shouldCompose) {
    // Sync composer pass params from the stack, then render (composer writes
    // to its internal buffers — it ignores renderer.setRenderTarget).
    updateViewfinderComposerFromStack(stack, renderer, viewfinder, scratchRenderSize)
    viewfinder.composer.render(delta)
    // Blit composer output into our target.
    const sourceTex = viewfinder.composer.readBuffer.texture
    if (sourceTex) blitTextureToTarget(renderer, sourceTex, target)
  } else {
    renderer.render(scene, virtCamera)
  }
  renderer.setRenderTarget(prevTarget)
  renderer.setClearColor(prevClearColor, prevClearAlpha)
  renderer.autoClear = prevAutoClear
  renderer.autoClearColor = prevAutoClearColor
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
