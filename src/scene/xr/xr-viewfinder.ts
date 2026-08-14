import * as THREE from 'three'
import type { MotionObject, PostProcessingStack } from '../../store'
import type { createViewfinderComposer } from '../../pip-composer'
import { renderViewfinderToTarget } from '../viewfinder-pass'

type ViewfinderComposer = ReturnType<typeof createViewfinderComposer>

export interface XrViewfinder {
  render: (ctx: {
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    virtCamera: THREE.PerspectiveCamera
    screenMesh: THREE.Mesh
    objects: MotionObject[]
    stack: PostProcessingStack
    width: number
    height: number
    delta: number
    t: number
    isObjectGizmoActive: (obj: MotionObject) => boolean
    clearColor?: string | THREE.Color
  }) => void
  dispose: () => void
}

export function createXrViewfinder(viewfinder: ViewfinderComposer): XrViewfinder {
  const target = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    // No MSAA: WebXR sessions often can't resolve multisampled offscreen
    // targets, which silently produces a black texture.
    depthBuffer: true,
  })

  function render(ctx: {
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    virtCamera: THREE.PerspectiveCamera
    screenMesh: THREE.Mesh
    objects: MotionObject[]
    stack: PostProcessingStack
    width: number
    height: number
    delta: number
    t: number
    isObjectGizmoActive: (obj: MotionObject) => boolean
    clearColor?: string | THREE.Color
  }): void {
    const { screenMesh, width, height } = ctx
    if (width <= 0 || height <= 0) return

    renderViewfinderToTarget({
      ...ctx,
      viewfinder,
      target,
    })

    // Re-point the mesh's own material rather than replacing it. Swapping in a
    // fresh MeshBasicMaterial silently discarded whatever the rig had
    // configured — depth testing above all, which is what keeps the set from
    // slicing through the card the screen now sits in.
    const mat = screenMesh.material as THREE.MeshBasicMaterial
    if (mat.map !== target.texture) {
      mat.map = target.texture
      mat.toneMapped = false
      mat.needsUpdate = true
    }
  }

  return {
    render,
    dispose: () => {
      // The screen mesh's material belongs to the rig, which disposes it —
      // this owns the render target and the composer passes only.
      target.dispose()
      viewfinder.pixelatedPass.dispose()
      viewfinder.bloomPass.dispose()
      viewfinder.ditherPass.dispose()
      viewfinder.outputPass.dispose()
      viewfinder.composer.dispose()
    },
  }
}
