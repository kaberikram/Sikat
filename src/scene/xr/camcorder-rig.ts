import * as THREE from 'three'
import {
  InputComponent,
  XRInputManager,
  type XRInputManager as XRInputManagerType,
} from '@iwsdk/xr-input'
import { applyLiveCameraPose } from '../../director/camera-pose'
import { useEditorStore } from '../../store'
import { tagSceneInfrastructure } from '../infrastructure'

/**
 * Quest grip space often has +Y along the pointing axis and +Z toward the floor
 * when held naturally. Three.js cameras look down local -Z, so we rotate +90° X
 * so "point the controller" aims the virtual cam into the room.
 */
const AIM_OFFSET = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0, 'XYZ'))
const LENS_FORWARD_M = 0.04

export interface CamcorderRig {
  group: THREE.Group
  screenMesh: THREE.Mesh
  xrInput: XRInputManagerType
  update: (delta: number, timeSec: number, xrManager: THREE.WebXRManager) => void
  bindSession: (session: XRSession) => void
  dispose: () => void
}

/** Keep IWSDK controller/hand meshes off the virtual cam (layer 0). */
function forceEditorLayer(root: THREE.Object3D): void {
  root.traverse((o) => o.layers.set(1))
}

export function createCamcorderRig(
  scene: THREE.Scene,
  userCamera: THREE.PerspectiveCamera,
  virtCamera: THREE.PerspectiveCamera
): CamcorderRig {
  const xrInput = new XRInputManager({
    scene,
    camera: userCamera,
    // Desktop picking stays on HTML/gizmo; XR ray pick is a later follow-up.
    pointerSettings: { enabled: false },
  })
  tagSceneInfrastructure(xrInput.xrOrigin)
  forceEditorLayer(xrInput.xrOrigin)
  scene.add(xrInput.xrOrigin)

  const group = new THREE.Group()
  group.layers.set(1)

  // Flip-out LCD: raised toward the tracking ring, facing the user.
  // Quest grip often has +Z toward the floor when held upright — face -Z (up) + tip toward -Y (user).
  // DoubleSide so both stereo eyes see the panel when near edge-on.
  const screenMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.14, 0.07875),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      depthTest: true,
    })
  )
  screenMesh.layers.set(1)
  screenMesh.position.set(0, 0.1, 0)
  screenMesh.rotation.set(Math.PI - 0.45, 0, 0)
  screenMesh.renderOrder = 10
  group.add(screenMesh)

  // Stable IWSDK grip space — no manual inputSources handedness fallback.
  xrInput.xrOrigin.gripSpaces.right.add(group)

  let takeLabel: THREE.Mesh | null = null
  let lastTakeNumber = 0

  const lensOffset = new THREE.Vector3(0, LENS_FORWARD_M, 0)
  const worldPos = new THREE.Vector3()
  const worldQuat = new THREE.Quaternion()
  const scratchScale = new THREE.Vector3()
  const euler = new THREE.Euler(0, 0, 0, 'XYZ')
  const aimQuat = new THREE.Quaternion()

  function toggleRecord(): void {
    const { isRolling, startTake, endTake } = useEditorStore.getState()
    if (isRolling) endTake()
    else startTake()
  }

  function updateRollingIndicator(): void {
    const { isRolling, takeNumber } = useEditorStore.getState()

    if (isRolling && (!takeLabel || takeNumber !== lastTakeNumber)) {
      if (takeLabel) {
        group.remove(takeLabel)
        const labelMat = takeLabel.material as THREE.MeshBasicMaterial
        labelMat.map?.dispose()
        takeLabel.geometry.dispose()
        labelMat.dispose()
        takeLabel = null
      }
      lastTakeNumber = takeNumber
      const canvas = document.createElement('canvas')
      canvas.width = 256
      canvas.height = 64
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.fillStyle = '#ffffff'
        ctx.font = 'bold 28px monospace'
        ctx.fillText(`TAKE ${takeNumber}`, 8, 40)
      }
      const tex = new THREE.CanvasTexture(canvas)
      takeLabel = new THREE.Mesh(
        new THREE.PlaneGeometry(0.08, 0.02),
        new THREE.MeshBasicMaterial({
          map: tex,
          transparent: true,
          depthTest: false,
          side: THREE.DoubleSide,
        })
      )
      takeLabel.layers.set(1)
      takeLabel.position.set(0, 0.13, 0)
      takeLabel.rotation.copy(screenMesh.rotation)
      takeLabel.renderOrder = 11
      group.add(takeLabel)
    } else if (!isRolling && takeLabel) {
      group.remove(takeLabel)
      const labelMat = takeLabel.material as THREE.MeshBasicMaterial
      labelMat.map?.dispose()
      takeLabel.geometry.dispose()
      labelMat.dispose()
      takeLabel = null
      lastTakeNumber = 0
    }
  }

  function update(delta: number, timeSec: number, xrManager: THREE.WebXRManager): void {
    xrInput.update(xrManager, delta, timeSec)
    // Newly loaded controller/hand GLTFs default to layer 0 — keep them off virt cam.
    forceEditorLayer(xrInput.xrOrigin)

    const pad = xrInput.gamepads.right
    if (
      pad &&
      (pad.getButtonDown(InputComponent.Trigger) || pad.getSelectStart())
    ) {
      toggleRecord()
    }

    updateRollingIndicator()

    const grip = xrInput.xrOrigin.gripSpaces.right
    grip.updateWorldMatrix(true, false)
    grip.matrixWorld.decompose(worldPos, worldQuat, scratchScale)
    // Aim along grip +Y (pointing), not raw grip -Z (often toward floor).
    aimQuat.copy(worldQuat).multiply(AIM_OFFSET)
    worldPos.add(lensOffset.clone().applyQuaternion(aimQuat))

    euler.setFromQuaternion(aimQuat, 'XYZ')
    applyLiveCameraPose({
      position: [worldPos.x, worldPos.y, worldPos.z],
      rotation: [euler.x, euler.y, euler.z],
    })
    virtCamera.position.set(worldPos.x, worldPos.y, worldPos.z)
    virtCamera.rotation.set(euler.x, euler.y, euler.z)
    virtCamera.updateMatrixWorld()
  }

  return {
    group,
    screenMesh,
    xrInput,
    update,
    // XRInputManager reads session from WebXRManager each frame — no bind needed.
    bindSession: () => {},
    dispose: () => {
      group.removeFromParent()
      scene.remove(xrInput.xrOrigin)
      screenMesh.geometry.dispose()
      ;(screenMesh.material as THREE.Material).dispose()
      if (takeLabel) {
        const labelMat = takeLabel.material as THREE.MeshBasicMaterial
        labelMat.map?.dispose()
        takeLabel.geometry.dispose()
        labelMat.dispose()
      }
    },
  }
}
