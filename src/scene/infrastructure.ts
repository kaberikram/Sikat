import * as THREE from 'three'

/**
 * Editor-only chrome (viewfinder, cursors, gizmo, stage ring).
 * Must NOT use layers 1 or 2 — Three.js WebXR reserves those for left/right eye
 * cameras (`cameraL.layers` clears bit 2, `cameraR` clears bit 1). Objects on
 * layer 1 only appear in the left eye.
 */
export const EDITOR_LAYER = 3

/**
 * Opaque virtual-camera backdrop (see createViewfinderBackdropMesh). Only the
 * virt-cam / review playback cameras enable this layer — never userCamera or
 * the WebXR eye cameras, so it stays invisible to the headset passthrough view.
 */
export const VIEWFINDER_BACKDROP_LAYER = 4

export function tagSceneInfrastructure(obj: THREE.Object3D) {
  obj.userData.isSceneInfrastructure = true
}

export function setEditorLayer(root: THREE.Object3D): void {
  root.traverse((o) => o.layers.set(EDITOR_LAYER))
}

/**
 * Real opaque geometry standing in for `scene.background`. While a WebXR
 * passthrough (alpha-blend) session is active, three.js's WebGLBackground
 * force-clears every render — including offscreen viewfinder targets — to
 * transparent black to composite with the camera feed, ignoring
 * `scene.background` / `renderer.setClearColor()` entirely. A flat clear
 * color can't survive that, so instead we give the virtual camera a physical
 * backdrop: a large inward-facing sphere centered on the camera (attach as a
 * child so it always encloses it) that real scene geometry depth-tests
 * against normally.
 */
export function createViewfinderBackdropMesh(radius: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 64, 32),
    new THREE.MeshBasicMaterial({
      color: 0xf2f2f2,
      side: THREE.BackSide,
      toneMapped: false,
      depthTest: true,
      depthWrite: true,
    })
  )
  mesh.layers.set(VIEWFINDER_BACKDROP_LAYER)
  tagSceneInfrastructure(mesh)
  return mesh
}
