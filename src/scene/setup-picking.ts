import * as THREE from 'three'
import { useEditorStore, VIRTUAL_CAMERA_ID } from '../store'

export function setupPicking(
  scene: THREE.Scene,
  userCamera: THREE.Camera,
  domElement: HTMLElement,
  isGizmoDragged: () => boolean,
  clearGizmoDrag: () => void
) {
  const pickRaycaster = new THREE.Raycaster()
  const pickPointer = new THREE.Vector2()
  let pickDownX = 0
  let pickDownY = 0

  function collectSelectableRoots(): THREE.Object3D[] {
    const roots: THREE.Object3D[] = []
    for (const child of scene.children) {
      if (child.userData?.isSceneInfrastructure) continue
      const id = child.userData?.id as string | undefined
      if (id) roots.push(child)
    }
    return roots
  }

  function pickObjectAt(clientX: number, clientY: number): string | null {
    const rect = domElement.getBoundingClientRect()
    pickPointer.x = ((clientX - rect.left) / rect.width) * 2 - 1
    pickPointer.y = -((clientY - rect.top) / rect.height) * 2 + 1
    pickRaycaster.setFromCamera(pickPointer, userCamera)
    const hits = pickRaycaster.intersectObjects(collectSelectableRoots(), true)
    for (const hit of hits) {
      let node: THREE.Object3D | null = hit.object
      while (node) {
        const id = node.userData?.id as string | undefined
        if (id) return id
        node = node.parent
      }
    }
    return null
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return
    pickDownX = e.clientX
    pickDownY = e.clientY
  }

  function onPointerUp(e: PointerEvent) {
    if (e.button !== 0) return
    const dx = e.clientX - pickDownX
    const dy = e.clientY - pickDownY
    if (dx * dx + dy * dy > 16) return
    if (isGizmoDragged()) {
      clearGizmoDrag()
      return
    }
    useEditorStore.getState().setSelected(pickObjectAt(e.clientX, e.clientY))
  }

  domElement.addEventListener('pointerdown', onPointerDown)
  domElement.addEventListener('pointerup', onPointerUp)

  return () => {
    domElement.removeEventListener('pointerdown', onPointerDown)
    domElement.removeEventListener('pointerup', onPointerUp)
  }
}
