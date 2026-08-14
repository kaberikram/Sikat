import * as THREE from 'three'
import { useEditorStore } from '../store'
import { setEditorLayer, tagSceneInfrastructure } from './infrastructure'

/** Flat ring on EDITOR_LAYER — main viewport only, never filmed. */
export function createStageMarker(scene: THREE.Scene): THREE.Group {
  const group = new THREE.Group()
  tagSceneInfrastructure(group)

  const mat = new THREE.MeshBasicMaterial({
    color: 0x888888,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
  })

  // Sole child: room-response.ts reads the tint material off children[0].
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1.0, 64), mat)
  ring.rotation.x = -Math.PI / 2
  group.add(ring)

  setEditorLayer(group)
  scene.add(group)
  return group
}

export function updateStageMarker(group: THREE.Group): void {
  const { stage } = useEditorStore.getState()
  group.visible = stage.visible
  group.position.set(...stage.position)
  const s = stage.radius
  group.scale.set(s, s, s)
}

export function disposeStageMarker(group: THREE.Group, scene: THREE.Scene): void {
  scene.remove(group)
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose()
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose())
      else o.material.dispose()
    }
  })
}
