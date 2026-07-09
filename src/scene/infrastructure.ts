import * as THREE from 'three'

/**
 * Editor-only chrome (viewfinder, cursors, gizmo, stage ring).
 * Must NOT use layers 1 or 2 — Three.js WebXR reserves those for left/right eye
 * cameras (`cameraL.layers` clears bit 2, `cameraR` clears bit 1). Objects on
 * layer 1 only appear in the left eye.
 */
export const EDITOR_LAYER = 3

export function tagSceneInfrastructure(obj: THREE.Object3D) {
  obj.userData.isSceneInfrastructure = true
}

export function setEditorLayer(root: THREE.Object3D): void {
  root.traverse((o) => o.layers.set(EDITOR_LAYER))
}
