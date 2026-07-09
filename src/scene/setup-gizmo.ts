import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { useEditorStore, VIRTUAL_CAMERA_ID } from '../store'
import { EDITOR_LAYER, setEditorLayer, tagSceneInfrastructure } from './infrastructure'

export function setupGizmo(
  scene: THREE.Scene,
  userCamera: THREE.Camera,
  domElement: HTMLElement,
  controls: OrbitControls
) {
  const transformControl = new TransformControls(userCamera, domElement)
  transformControl.setMode('translate')
  transformControl.setSize(1.1)
  transformControl.getRaycaster().layers.set(EDITOR_LAYER)
  const gizmoHelper = transformControl.getHelper()
  setEditorLayer(gizmoHelper)
  tagSceneInfrastructure(gizmoHelper as unknown as THREE.Object3D)
  scene.add(gizmoHelper)

  function syncGizmoToStore() {
    const o = transformControl.object
    if (!o) return
    const id = o.userData?.id as string | undefined
    if (!id) return
    if (id === VIRTUAL_CAMERA_ID) {
      const c = o as THREE.PerspectiveCamera
      const euler = c.rotation
      useEditorStore.getState().updateCamera({
        position: [c.position.x, c.position.y, c.position.z],
        rotation: [euler.x, euler.y, euler.z],
        fov: c.fov,
      })
      return
    }
    const euler = o.rotation
    useEditorStore.getState().updateObject(id, {
      position: [o.position.x, o.position.y, o.position.z],
      rotation: [euler.x, euler.y, euler.z],
      scale: [o.scale.x, o.scale.y, o.scale.z],
    })
  }

  transformControl.addEventListener('objectChange', syncGizmoToStore)

  let gizmoDragged = false
  transformControl.addEventListener('dragging-changed', (event) => {
    if (event.value) gizmoDragged = true
  })

  transformControl.addEventListener('mouseDown', () => {
    controls.enabled = false
    gizmoDragged = false
  })
  transformControl.addEventListener('mouseUp', () => {
    controls.enabled = true
    const o = transformControl.object
    if (!o || !gizmoDragged) return
    const id = o.userData?.id as string | undefined
    if (!id) return
    // Auto-keyframe on release ONLY while a take is rolling or when the
    // entity is already animated. Baking keyframes on a plain drag makes the
    // base pose dead — the entity looks "locked" to wherever the playhead
    // interpolates it, and later base-pose writes (agent MOVE_CAMERA/
    // TRANSFORM tweens, fov sliders) become invisible.
    const st = useEditorStore.getState()
    const t = st.currentTime
    if (id === VIRTUAL_CAMERA_ID) {
      if (st.isRolling || st.virtualCamera.keyframes.length > 0) st.snapshotCameraKeyframes(t)
    } else {
      const obj = st.objects.find((ob) => ob.id === id)
      if (st.isRolling || (obj && obj.keyframes.length > 0)) st.snapshotObjectKeyframes(id, t)
    }
  })

  return {
    transformControl,
    isGizmoDragged: () => gizmoDragged,
    clearGizmoDrag: () => { gizmoDragged = false },
  }
}
