import * as THREE from 'three'
import { applyLiveCameraPose } from '../../director/camera-pose'
import { useEditorStore } from '../../store'

const LENS_FORWARD_M = 0.06

export interface CamcorderRig {
  group: THREE.Group
  screenMesh: THREE.Mesh
  update: (frame: XRFrame, referenceSpace: XRReferenceSpace) => void
  bindSession: (session: XRSession) => void
  dispose: () => void
}

export function createCamcorderRig(renderer: THREE.WebGLRenderer, scene: THREE.Scene): CamcorderRig {
  const group = new THREE.Group()
  group.layers.set(1)

  // Three.js requires controller grips in the scene graph for XR input + attached meshes.
  for (let i = 0; i < 2; i++) {
    scene.add(renderer.xr.getController(i))
    scene.add(renderer.xr.getControllerGrip(i))
  }

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.14, 0.09, 0.05),
    new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.85, metalness: 0.1 })
  )
  body.layers.set(1)
  body.position.set(0, 0, -0.02)
  group.add(body)

  const screenMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.12, 0.0675),
    new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.DoubleSide })
  )
  screenMesh.layers.set(1)
  screenMesh.position.set(0, 0.02, -0.028)
  screenMesh.rotation.x = -0.35
  group.add(screenMesh)

  const recFrame = new THREE.Mesh(
    new THREE.PlaneGeometry(0.124, 0.0715),
    new THREE.MeshBasicMaterial({ color: 0xcc0000, transparent: true, opacity: 0, side: THREE.DoubleSide })
  )
  recFrame.layers.set(1)
  recFrame.position.copy(screenMesh.position)
  recFrame.position.z -= 0.001
  recFrame.rotation.copy(screenMesh.rotation)
  group.add(recFrame)

  let rightInputSource: XRInputSource | null = null
  let takeLabel: THREE.Mesh | null = null
  let lastTakeNumber = 0

  const lensOffset = new THREE.Vector3(0, 0.02, -LENS_FORWARD_M)
  const worldPos = new THREE.Vector3()
  const worldQuat = new THREE.Quaternion()
  const scratchScale = new THREE.Vector3()
  const euler = new THREE.Euler(0, 0, 0, 'XYZ')
  const scratchMat = new THREE.Matrix4()

  function onSelectStart(): void {
    const { isRolling, startTake, endTake } = useEditorStore.getState()
    if (isRolling) endTake()
    else startTake()
  }

  function attachRightGrip(index: number, source: XRInputSource): void {
    rightInputSource = source
    const rightGrip = renderer.xr.getControllerGrip(index)
    if (!rightGrip.children.includes(group)) rightGrip.add(group)

    const controller = renderer.xr.getController(index)
    controller.removeEventListener('selectstart', onSelectStart)
    controller.addEventListener('selectstart', onSelectStart)
  }

  function bindSession(session: XRSession): void {
    const syncInputs = () => {
      let rightIndex = -1
      let fallbackIndex = -1
      for (let i = 0; i < session.inputSources.length; i++) {
        const source = session.inputSources[i]
        if (!source?.gripSpace) continue
        if (fallbackIndex < 0) fallbackIndex = i
        if (source.handedness === 'right') rightIndex = i
      }
      const index = rightIndex >= 0 ? rightIndex : fallbackIndex
      if (index >= 0) attachRightGrip(index, session.inputSources[index]!)
    }
    syncInputs()
    session.addEventListener('inputsourceschange', syncInputs)
  }

  function updateRollingIndicator(): void {
    const { isRolling, takeNumber } = useEditorStore.getState()
    const mat = recFrame.material as THREE.MeshBasicMaterial
    mat.opacity = isRolling ? 0.95 : 0

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
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false })
      )
      takeLabel.layers.set(1)
      takeLabel.position.set(0, 0.055, -0.03)
      takeLabel.rotation.x = -0.35
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

  function update(frame: XRFrame, referenceSpace: XRReferenceSpace): void {
    updateRollingIndicator()
    if (!rightInputSource?.gripSpace) return

    const pose = frame.getPose(rightInputSource.gripSpace, referenceSpace)
    if (!pose) return

    scratchMat.fromArray(pose.transform.matrix)
    scratchMat.decompose(worldPos, worldQuat, scratchScale)
    worldPos.add(lensOffset.clone().applyQuaternion(worldQuat))

    euler.setFromQuaternion(worldQuat, 'XYZ')
    applyLiveCameraPose({
      position: [worldPos.x, worldPos.y, worldPos.z],
      rotation: [euler.x, euler.y, euler.z],
    })
  }

  return {
    group,
    screenMesh,
    update,
    bindSession,
    dispose: () => {
      group.removeFromParent()
      body.geometry.dispose()
      ;(body.material as THREE.Material).dispose()
      screenMesh.geometry.dispose()
      ;(screenMesh.material as THREE.Material).dispose()
      recFrame.geometry.dispose()
      recFrame.material.dispose()
      if (takeLabel) {
        const labelMat = takeLabel.material as THREE.MeshBasicMaterial
        labelMat.map?.dispose()
        takeLabel.geometry.dispose()
        labelMat.dispose()
      }
    },
  }
}
