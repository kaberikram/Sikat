import * as THREE from 'three'

export function ensureShadowsOnObjectMeshes(
  liveObjects: { mesh?: THREE.Object3D; subMeshShadow?: Record<string, boolean> }[]
) {
  for (const obj of liveObjects) {
    if (!obj.mesh) continue
    const off = obj.subMeshShadow
    obj.mesh.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const m = child as THREE.Mesh
        if (!m.userData.isCellOutlineShell) {
          if (off?.[m.uuid] === false) {
            m.castShadow = false
            m.receiveShadow = false
          } else {
            m.castShadow = true
            m.receiveShadow = true
          }
        }
      }
    })
  }
}
