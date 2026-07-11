import * as THREE from 'three'
import {
  InputComponent,
  XRInputManager,
  type XRInputManager as XRInputManagerType,
} from '@iwsdk/xr-input'
import { applyLiveCameraPose } from '../../director/camera-pose'
import { submitDirectorCommand } from '../../director/director-command'
import { getDirectorSocket } from '../../director/socket'
import {
  finishVoiceSession,
  isSpeechAvailable,
  isVoiceListening,
  startVoiceSession,
  stopVoiceSession,
} from '../../director/voice-session'
import { useEditorStore } from '../../store'
import { setEditorLayer, tagSceneInfrastructure } from '../infrastructure'
import { createDirectorSlate } from './director-slate'
import { makeBadgeTexture } from './xr-ui-chrome'

/**
 * WebXR grip −Z is camera-forward (same as Three.js).
 * Pitch the aim up from that axis so a natural hold looks slightly above the barrel.
 */
const AIM_UP_DEG = 30
const AIM_UP_RAD = (AIM_UP_DEG * Math.PI) / 180
/** Local X pitch: negative = tip aim upward (toward grip +Y). */
const AIM_OFFSET = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(-AIM_UP_RAD, 0, 0, 'XYZ')
)
const LENS_FORWARD_M = 0.05
const AIM_RAY_LEN = 2.5

export interface CamcorderRig {
  group: THREE.Group
  screenMesh: THREE.Mesh
  xrInput: XRInputManagerType
  update: (delta: number, timeSec: number, xrManager: THREE.WebXRManager) => void
  bindSession: (session: XRSession) => void
  setTakeEndedHandler: (
    fn: ((takeStart: number, takeEnd: number, head: THREE.Object3D) => void) | null
  ) => void
  setSuppressRec: (fn: (() => boolean) | null) => void
  dispose: () => void
}

export function createCamcorderRig(
  scene: THREE.Scene,
  userCamera: THREE.PerspectiveCamera,
  virtCamera: THREE.PerspectiveCamera
): CamcorderRig {
  const xrInput = new XRInputManager({
    scene,
    camera: userCamera,
    pointerSettings: { enabled: false },
  })
  tagSceneInfrastructure(xrInput.xrOrigin)
  setEditorLayer(xrInput.xrOrigin)
  scene.add(xrInput.xrOrigin)

  const group = new THREE.Group()
  setEditorLayer(group)

  // Point-and-shoot: grip −Z = barrel. Screen is a rear LCD facing the shooter (+Z).
  // Plane default faces +Z — leave that, tip slightly toward the eyes.
  const screenMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.14, 0.07875),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      depthTest: true,
    })
  )
  // Above the grip (+Y), slightly toward the hand (+Z = back when −Z is aim).
  screenMesh.position.set(0, 0.06, -0.0525)
  screenMesh.rotation.set(-0.436, 0, 0) // −25° tip toward the eyes
  screenMesh.renderOrder = 10
  group.add(screenMesh)

  const directorSlate = createDirectorSlate(screenMesh)

  // Debug aim ray — matches virt cam forward (grip −Z pitched AIM_UP_DEG up).
  const aimRay = new THREE.Mesh(
    new THREE.CylinderGeometry(0.003, 0.003, AIM_RAY_LEN, 8),
    new THREE.MeshBasicMaterial({
      color: 0xff3300,
      depthTest: false,
      transparent: true,
      opacity: 0.85,
    })
  )
  // Cylinder default +Y → −Z, then same upward pitch as the virt cam.
  aimRay.rotation.set(Math.PI / 2 - AIM_UP_RAD, 0, 0)
  const rayMid = new THREE.Vector3(0, 0.01, -AIM_RAY_LEN / 2 - LENS_FORWARD_M)
  rayMid.applyQuaternion(AIM_OFFSET)
  aimRay.position.copy(rayMid)
  aimRay.renderOrder = 20
  group.add(aimRay)

  const aimTip = new THREE.Mesh(
    new THREE.SphereGeometry(0.012, 12, 12),
    new THREE.MeshBasicMaterial({
      color: 0xffee00,
      depthTest: false,
    })
  )
  const tipPos = new THREE.Vector3(0, 0.01, -AIM_RAY_LEN - LENS_FORWARD_M)
  tipPos.applyQuaternion(AIM_OFFSET)
  aimTip.position.copy(tipPos)
  aimTip.renderOrder = 21
  group.add(aimTip)

  setEditorLayer(group)

  xrInput.xrOrigin.gripSpaces.right.add(group)

  let takeLabel: THREE.Mesh | null = null
  let lastTakeNumber = 0
  let onTakeEnded:
    | ((takeStart: number, takeEnd: number, head: THREE.Object3D) => void)
    | null = null
  let suppressRec: (() => boolean) | null = null

  const lensOffset = new THREE.Vector3(0, 0.01, -LENS_FORWARD_M)
  const worldPos = new THREE.Vector3()
  const worldQuat = new THREE.Quaternion()
  const scratchScale = new THREE.Vector3()
  const euler = new THREE.Euler(0, 0, 0, 'XYZ')
  const aimQuat = new THREE.Quaternion()

  function toggleRecord(): void {
    if (suppressRec?.()) return
    const st = useEditorStore.getState()
    if (st.isRolling) {
      const takeStart = st.takeStartTime
      st.endTake()
      const takeEnd = useEditorStore.getState().currentTime
      onTakeEnded?.(takeStart, takeEnd, xrInput.xrOrigin.head)
      return
    }
    st.startTake()
  }

  function beginTalk(): void {
    if (!isSpeechAvailable()) {
      directorSlate.setLastSent('mic unavailable')
      return
    }
    directorSlate.setOffline(getDirectorSocket().status !== 'open')
    startVoiceSession({
      onListeningChange: (on) => directorSlate.setListening(on),
      onInterim: (text) => directorSlate.setInterim(text),
      onError: (error) => directorSlate.setLastSent(`voice error: ${error}`),
      onFinal: (transcript) => {
        const commandId = crypto.randomUUID()
        void submitDirectorCommand(transcript, {
          forceVision: true,
          commandId,
          onNoResponse: () => directorSlate.setLastSent('no response'),
        }).then((result) => {
          const line = transcript.trim()
          if (result.offline) {
            directorSlate.setOffline(true)
            directorSlate.setLastSent(line || 'offline')
          } else if (result.ok) {
            directorSlate.setOffline(false)
            directorSlate.setLastSent(line)
          }
        })
      },
    })
  }

  function endTalk(): void {
    // Graceful finish: the final transcript lands *after* release (both on
    // Chrome and the SEPIA polyfill), so keep handlers alive while it drains.
    if (isVoiceListening()) finishVoiceSession()
    directorSlate.setListening(false)
    directorSlate.setInterim('')
  }

  function updateRollingIndicator(): void {
    const { isRolling, takeNumber } = useEditorStore.getState()

    if (isRolling && (!takeLabel || takeNumber !== lastTakeNumber)) {
      if (takeLabel) {
        screenMesh.remove(takeLabel)
        const labelMat = takeLabel.material as THREE.MeshBasicMaterial
        labelMat.map?.dispose()
        takeLabel.geometry.dispose()
        labelMat.dispose()
        takeLabel = null
      }
      lastTakeNumber = takeNumber
      // One badge: TAKE N + red REC dot on the right edge (no separate box).
      const tex = makeBadgeTexture(`TAKE ${takeNumber}`, { recDot: true })
      takeLabel = new THREE.Mesh(
        new THREE.PlaneGeometry(0.1, 0.022),
        new THREE.MeshBasicMaterial({
          map: tex,
          transparent: true,
          depthTest: false,
          side: THREE.DoubleSide,
          toneMapped: false,
        })
      )
      takeLabel.position.set(0, 0.032, 0.001)
      takeLabel.renderOrder = 11
      screenMesh.add(takeLabel)
      setEditorLayer(takeLabel)
    } else if (!isRolling && takeLabel) {
      screenMesh.remove(takeLabel)
      const labelMat = takeLabel.material as THREE.MeshBasicMaterial
      labelMat.map?.dispose()
      takeLabel.geometry.dispose()
      labelMat.dispose()
      takeLabel = null
      lastTakeNumber = 0
    }

    // Blink the whole badge opacity so the baked REC dot pulses.
    if (takeLabel && isRolling) {
      ;(takeLabel.material as THREE.MeshBasicMaterial).opacity =
        Math.sin(performance.now() * 0.012) > 0 ? 1 : 0.55
    }
  }

  function update(delta: number, timeSec: number, xrManager: THREE.WebXRManager): void {
    xrInput.update(xrManager, delta, timeSec)
    setEditorLayer(xrInput.xrOrigin)

    const pad = xrInput.gamepads.right
    if (
      pad &&
      (pad.getButtonDown(InputComponent.Trigger) || pad.getSelectStart())
    ) {
      toggleRecord()
    }

    // Hold A = push-to-talk (right hand only; trigger stays REC).
    if (pad?.getButtonDown(InputComponent.A_Button)) beginTalk()
    if (pad?.getButtonUp(InputComponent.A_Button)) endTalk()

    updateRollingIndicator()

    const grip = xrInput.xrOrigin.gripSpaces.right
    grip.updateWorldMatrix(true, false)
    grip.matrixWorld.decompose(worldPos, worldQuat, scratchScale)
    // Grip −Z + AIM_UP_DEG pitch (natural hold aims slightly above the barrel).
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
    bindSession: () => {},
    setTakeEndedHandler: (fn) => {
      onTakeEnded = fn
    },
    setSuppressRec: (fn) => {
      suppressRec = fn
    },
    dispose: () => {
      stopVoiceSession()
      directorSlate.dispose()
      group.removeFromParent()
      scene.remove(xrInput.xrOrigin)
      screenMesh.geometry.dispose()
      ;(screenMesh.material as THREE.Material).dispose()
      aimRay.geometry.dispose()
      ;(aimRay.material as THREE.Material).dispose()
      aimTip.geometry.dispose()
      ;(aimTip.material as THREE.Material).dispose()
      if (takeLabel) {
        const labelMat = takeLabel.material as THREE.MeshBasicMaterial
        labelMat.map?.dispose()
        takeLabel.geometry.dispose()
        labelMat.dispose()
      }
    },
  }
}
