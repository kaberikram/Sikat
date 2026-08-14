/**
 * Timeline playback into a render target — the grip well's take-review feed.
 *
 * Same FX stack as the live viewfinder, filmed through a camera that follows
 * the take's keyframes rather than the live grip pose. The rig swaps this
 * texture onto the LCD while reviewing and lets the live viewfinder take it
 * back on exit.
 */
import * as THREE from 'three'
import { createViewfinderComposer } from '../../pip-composer'
import type { MotionObject, PostProcessingStack } from '../../store'
import { useEditorStore } from '../../store'
import { applyVirtualCameraAtTime } from '../../timeline-apply'
import { createViewfinderBackdropMesh, VIEWFINDER_BACKDROP_LAYER } from '../infrastructure'
import { renderViewfinderToTarget } from '../viewfinder-pass'

const PLAYBACK_W = 640
const PLAYBACK_H = 360

export interface TakePlayback {
  texture: THREE.Texture
  render: (ctx: {
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    objects: MotionObject[]
    stack: PostProcessingStack
    delta: number
    t: number
    clearColor: string
    isObjectGizmoActive: (obj: MotionObject) => boolean
  }) => void
  dispose: () => void
}

export function createTakePlayback(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  cameraFar: number
): TakePlayback {
  const playbackCam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, cameraFar)
  playbackCam.layers.set(0)
  playbackCam.layers.enable(VIEWFINDER_BACKDROP_LAYER)

  const playbackBackdrop = createViewfinderBackdropMesh(cameraFar * 0.9)
  playbackCam.add(playbackBackdrop)

  const viewfinder = createViewfinderComposer(
    scene,
    playbackCam,
    renderer,
    renderer.getPixelRatio()
  )

  const target = new THREE.WebGLRenderTarget(PLAYBACK_W, PLAYBACK_H, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
  })

  return {
    texture: target.texture,
    render: (ctx) => {
      const vc = useEditorStore.getState().virtualCamera
      applyVirtualCameraAtTime(ctx.t, vc, playbackCam)
      ;(playbackBackdrop.material as THREE.MeshBasicMaterial).color.set(ctx.clearColor)
      renderViewfinderToTarget({
        objects: ctx.objects,
        stack: ctx.stack,
        renderer: ctx.renderer,
        scene: ctx.scene,
        virtCamera: playbackCam,
        viewfinder,
        target,
        width: PLAYBACK_W,
        height: PLAYBACK_H,
        delta: ctx.delta,
        t: ctx.t,
        isObjectGizmoActive: ctx.isObjectGizmoActive,
        clearColor: ctx.clearColor,
      })
    },
    dispose: () => {
      target.dispose()
      playbackBackdrop.geometry.dispose()
      ;(playbackBackdrop.material as THREE.Material).dispose()
      viewfinder.pixelatedPass.dispose()
      viewfinder.bloomPass.dispose()
      viewfinder.ditherPass.dispose()
      viewfinder.outputPass.dispose()
      viewfinder.composer.dispose()
    },
  }
}
