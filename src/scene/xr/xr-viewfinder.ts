import * as THREE from 'three'
import type { MotionObject, PostProcessingStack } from '../../store'
import {
  applyViewfinderMeshEffects,
  stripViewfinderObjectEffects,
} from '../../viewfinder-mesh-fx'
import { applyObjectTransformAtTime } from '../../timeline-apply'

const RT_WIDTH = 1280
const RT_HEIGHT = 720

export interface XrViewfinder {
  render: (ctx: {
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    virtCamera: THREE.PerspectiveCamera
    screenMesh: THREE.Mesh
    objects: MotionObject[]
    stack: PostProcessingStack
    t: number
    isObjectGizmoActive: (obj: MotionObject) => boolean
  }) => void
  dispose: () => void
}

export function createXrViewfinder(): XrViewfinder {
  const target = new THREE.WebGLRenderTarget(RT_WIDTH, RT_HEIGHT, {
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
    t: number
    isObjectGizmoActive: (obj: MotionObject) => boolean
  }): void {
    const {
      renderer,
      scene,
      virtCamera,
      screenMesh,
      objects,
      stack,
      t,
      isObjectGizmoActive,
    } = ctx

    if (screenMesh.material !== screenMaterial) {
      screenMaterial?.map?.dispose()
      screenMaterial = new THREE.MeshBasicMaterial({
        map: target.texture,
        toneMapped: false,
        side: THREE.DoubleSide,
      })
      screenMesh.material = screenMaterial
    }

    stripViewfinderObjectEffects(objects)
    applyViewfinderMeshEffects(objects, stack)

    const prevAspect = virtCamera.aspect
    virtCamera.aspect = RT_WIDTH / RT_HEIGHT
    virtCamera.updateProjectionMatrix()

    const prevTarget = renderer.getRenderTarget()
    renderer.setRenderTarget(target)
    renderer.clear()
    renderer.render(scene, virtCamera)
    renderer.setRenderTarget(prevTarget)

    stripViewfinderObjectEffects(objects)
    for (const obj of objects) {
      if (!obj.mesh || isObjectGizmoActive(obj)) continue
      applyObjectTransformAtTime(t, obj)
    }

    virtCamera.aspect = prevAspect
    virtCamera.updateProjectionMatrix()
  }

  return {
    render,
    dispose: () => {
      target.dispose()
      screenMaterial?.map?.dispose()
      screenMaterial?.dispose()
    },
  }
}
