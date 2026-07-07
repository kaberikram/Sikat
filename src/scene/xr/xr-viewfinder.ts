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
  }) => void
  dispose: () => void
}

export function createXrViewfinder(viewfinder: ViewfinderComposer): XrViewfinder {
  const target = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  })

  let screenMaterial: THREE.MeshBasicMaterial | null = null

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
  }): void {
    const { screenMesh, width, height } = ctx
    if (width <= 0 || height <= 0) return

    renderViewfinderToTarget({
      ...ctx,
      viewfinder,
      target,
    })

    if (screenMesh.material !== screenMaterial) {
      screenMaterial?.map?.dispose()
      screenMaterial = new THREE.MeshBasicMaterial({
        map: target.texture,
        toneMapped: false,
        side: THREE.DoubleSide,
      })
      screenMesh.material = screenMaterial
    }
  }

  return {
    render,
    dispose: () => {
      target.dispose()
      screenMaterial?.map?.dispose()
      screenMaterial?.dispose()
      viewfinder.pixelatedPass.dispose()
      viewfinder.bloomPass.dispose()
      viewfinder.ditherPass.dispose()
      viewfinder.outputPass.dispose()
      viewfinder.composer.dispose()
    },
  }
}
