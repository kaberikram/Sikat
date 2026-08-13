import * as THREE from 'three'
import {
  InputComponent,
  XRInputManager,
  type XRInputManager as XRInputManagerType,
} from '@iwsdk/xr-input'
import { applyLiveCameraPose } from '../../director/camera-pose'
import { retireAllCursors } from '../../director/agent-runtime'
import { resolveTarget } from '../../director/command-applier'
import { submitDirectorCommand } from '../../director/director-command'
import { newCommandId } from '../../director/ids'
import type { CommandPacket, Target } from '../../director/protocol'
import { getDirectorSocket } from '../../director/socket'
import {
  finishVoiceSession,
  isDeepgramConfigured,
  isSpeechAvailable,
  isVoiceListening,
  primeVoiceCapture,
  startVoiceSession,
  stopVoiceSession,
} from '../../director/voice-session'
import { beatTick, missedBuzz } from '../../director/sound'
import { useEditorStore } from '../../store'
import { setEditorLayer, tagSceneInfrastructure } from '../infrastructure'
import { bindAmbientChannel, resetAmbientChannel, respond } from './ambient-channel'
import {
  getAmbientSignals,
  noteAmbientCommand,
  noteAmbientTake,
  resetAmbientSense,
  updateAmbientSense,
} from './ambient-sense'
import { createDirectorSlate } from './director-slate'
import { setRoomStillness } from './room-response'
import { playStageLockPulse, startEntrySequence } from './entry-sequence'
import { doublePulse, pulse } from './haptics'
import {
  computeStagePose,
  isHeadPoseValid,
  shouldReplaceStage,
  standoffBetween,
  STAGE_STANDOFF_M,
  STANDOFF_RANGE,
  type V3,
} from './stage-placement'
import { getProfile, noteSessionStart, noteStandoff, preferredStandoff } from './director-profile'
import { registerStagePlacer, registerTakeToggler } from './xr-bridge'
import { noteCoachAction, setCoachHesitation, startXrCoach, stopXrCoach } from './xr-coach'
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
/** Enter without a valid head pose after this long rather than waiting forever. */
const ENTRY_POSE_TIMEOUT_SEC = 3

/** Only learn a working distance from a director who has actually settled. */
const WORKING_SAMPLE_STILLNESS = 0.75
const WORKING_SAMPLE_INTERVAL_MS = 4000

const LENS_FORWARD_M = 0.05

/**
 * Which object is this packet about? Used to send attention to the target
 * before the change lands. Payload shapes differ per command, so this reads
 * whichever target-ish field the packet happens to carry and hands it to the
 * applier's own resolver, keeping name-matching (including "the ball") in one
 * place. Scene-wide packets (lights, FX, playback) have no object — null.
 */
function resolvePacketTargetId(packet: CommandPacket): string | null {
  const payload = packet.payload as { target?: Target | null; id?: string | null; name?: string | null }
  if (!payload) return null
  const target: Target | null = payload.target
    ?? (payload.id || payload.name ? { id: payload.id, name: payload.name } : null)
  return resolveTarget(target)?.id ?? null
}

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
  // The world answers first; the slate is what's left when it can't.
  directorSlate.setAmbient(true)
  bindAmbientChannel(directorSlate)

  setEditorLayer(group)

  xrInput.xrOrigin.gripSpaces.right.add(group)

  let takeLabel: THREE.Mesh | null = null
  let lastTakeNumber = 0
  let onTakeEnded:
    | ((takeStart: number, takeEnd: number, head: THREE.Object3D) => void)
    | null = null
  let suppressRec: (() => boolean) | null = null
  /** The line we're waiting on the crew for — echoed once work starts. */
  let thinkingLine: string | null = null
  /** Last non-empty interim of the current hold — what to show on release. */
  let lastInterim = ''

  // Route director replies / misses / first-work through the ambient channel,
  // which decides whether the set answers or the slate does.
  const socket = getDirectorSocket()
  const offSlateLog = socket.onLog((msg) => {
    if (!useEditorStore.getState().xrActive) return
    if (msg.kind === 'miss') {
      thinkingLine = null
      // The crew writes its own redirect ("copy — give me a move on set"); the
      // channel holds it back on a first miss and shows it on a second.
      respond({ kind: 'missed', text: msg.message })
      return
    }
    if (
      (msg.kind === 'reply' || msg.agent === 'DirectorsAssistant') &&
      msg.level === 'info' &&
      msg.forCommandId
    ) {
      thinkingLine = null
      respond({ kind: 'said', text: msg.message })
    }
  })
  const offSlatePacket = socket.onPacket((packet) => {
    if (!useEditorStore.getState().xrActive) return
    // First evidence of crew work — the set is about to change, so attention
    // travels to the target before the change lands.
    const targetId = resolvePacketTargetId(packet)
    if (targetId) respond({ kind: 'addressed', objectId: targetId })
    if (thinkingLine) {
      thinkingLine = null
      respond({ kind: 'landed', objectId: targetId })
    }
  })

  const lensOffset = new THREE.Vector3(0, 0.01, -LENS_FORWARD_M)
  const scratchOffset = new THREE.Vector3()
  const worldPos = new THREE.Vector3()
  const worldQuat = new THREE.Quaternion()
  const scratchScale = new THREE.Vector3()
  const euler = new THREE.Euler(0, 0, 0, 'XYZ')
  const aimQuat = new THREE.Quaternion()

  const headPos = new THREE.Vector3()
  const headQuat = new THREE.Quaternion()
  const headForward = new THREE.Vector3()

  /** Session entry waits for the first tracked head pose — placing the stage
   *  (and the entry cinematic) from the identity pose puts everything at the
   *  guardian center instead of in front of the user. */
  let pendingEntry = false
  let pendingEntrySec = 0
  let lastDistanceSampleAt = 0
  /** Last frame's right pad — button handlers fire outside update()'s scope. */
  let padRef: ReturnType<typeof getRightPad> = null
  let padMissingSec = 0
  let controllerNoticeShown = false

  function getRightPad() {
    return xrInput.gamepads.right ?? null
  }

  function readHeadPose(): { pos: V3; forward: V3 } {
    const head = xrInput.xrOrigin.head
    head.updateWorldMatrix(true, false)
    head.getWorldPosition(headPos)
    head.getWorldQuaternion(headQuat)
    headForward.set(0, 0, -1).applyQuaternion(headQuat)
    return {
      pos: [headPos.x, headPos.y, headPos.z],
      forward: [headForward.x, headForward.y, headForward.z],
    }
  }

  /**
   * How far ahead this director actually likes the set. A first-timer gets the
   * house distance; someone who keeps backing off to frame a wide gets their
   * own, blended rather than copied.
   */
  function standoffForThisDirector(): number {
    return preferredStandoff(getProfile(), STAGE_STANDOFF_M, STANDOFF_RANGE)
  }

  /**
   * Learn the director's working distance from where they actually stand.
   *
   * This used to record the distance we had *just computed* for the placement —
   * so the profile only ever learned its own output. The blend
   * `0.4 × default + 0.6 × median` has its fixed point at the default, so any
   * real preference decayed straight back to 1.9m and the personalisation could
   * never do anything. Sampling a settled director instead gives it something
   * real to learn from: if they habitually back off to frame a wide, the set
   * starts appearing there.
   */
  function sampleWorkingDistance(nowMs: number, stillness: number): void {
    if (stillness < WORKING_SAMPLE_STILLNESS) return
    if (nowMs - lastDistanceSampleAt < WORKING_SAMPLE_INTERVAL_MS) return
    const { pos } = readHeadPose()
    if (!isHeadPoseValid(pos)) return
    const stage = useEditorStore.getState().stage.position
    const d = standoffBetween(pos, stage)
    if (d < STANDOFF_RANGE[0] || d > STANDOFF_RANGE[1]) return
    lastDistanceSampleAt = nowMs
    noteStandoff(d)
  }

  /** Move the stage in front of the user (only after a real move) — the whole
   *  set, entry ripple, and crew stations follow the store's stage anchor. */
  function placeStageAtCurrentUser(): void {
    const { pos, forward } = readHeadPose()
    if (!isHeadPoseValid(pos)) return
    const st = useEditorStore.getState()
    const standoff = standoffForThisDirector()
    if (!shouldReplaceStage(pos, forward, st.stage.position, standoff)) return
    const position = computeStagePose(pos, forward, standoff).position
    st.relocateStage(position)
    playStageLockPulse()
    beatTick()
  }
  registerStagePlacer(placeStageAtCurrentUser)

  /**
   * The one path a take starts or stops by, whether the trigger pulled it or a
   * voice cue did. Returns false when the rig declined, so a voice caller can
   * fall back rather than silently doing nothing.
   */
  function toggleRecord(): boolean {
    if (suppressRec?.()) {
      // The review monitor owns the take controls right now — say so, don't go
      // mute. This used to gate the trigger only, so a spoken "action" could
      // start a take over an open, playing monitor.
      missedBuzz()
      pulse(padRef, 0.3, 40)
      respond({ kind: 'blocked', text: 'dismiss the monitor to roll again' })
      return false
    }
    const st = useEditorStore.getState()
    if (st.isRolling) {
      const takeStart = st.takeStartTime
      const takeNumber = st.takeNumber
      st.endTake()
      doublePulse(padRef, 0.5, 40)
      const takeEnd = useEditorStore.getState().currentTime
      noteAmbientTake(performance.now())
      onTakeEnded?.(takeStart, takeEnd, xrInput.xrOrigin.head)
      // The review monitor swinging into view is the answer; the line only
      // carries the part the monitor can't — where the take went.
      respond({ kind: 'status', text: `take ${takeNumber} saved to the timeline — export on desktop` })
      return true
    }
    st.startTake()
    pulse(padRef, 0.8, 70)
    noteCoachAction('rec')
    return true
  }

  // "action" / "cut" by voice runs exactly this, so a spoken take gets the
  // haptics, the take timestamp and the monitor the trigger has always given it.
  registerTakeToggler(() => toggleRecord())

  function beginTalk(): void {
    if (!isSpeechAvailable()) {
      missedBuzz()
      respond({
        kind: 'blocked',
        text:
          useEditorStore.getState().xrActive && !isDeepgramConfigured()
            ? 'voice needs Deepgram key'
            : 'mic unavailable',
      })
      return
    }
    if (useEditorStore.getState().micGranted === false) {
      // A denial before entry is not permanent — re-ask rather than refusing
      // for the rest of the session. If it's still blocked, the voice session
      // reports 'not-allowed' through onError below.
      void primeVoiceCapture().then((ok) => useEditorStore.getState().setMicGranted(ok))
    }
    lastInterim = ''
    pulse(padRef, 0.3, 25)
    // The room warms and starts breathing with your level — that is the mic
    // indicator now, at stage scale rather than 3mm under your hand.
    respond({ kind: 'heard', on: true })
    respond({ kind: 'offline', on: getDirectorSocket().status !== 'open' })
    void startVoiceSession({
      onListeningChange: (on) => directorSlate.setListening(on),
      onInterim: (text) => {
        if (text) lastInterim = text
        directorSlate.setInterim(text)
      },
      onLevel: (level) => {
        directorSlate.setLevel(level)
        respond({ kind: 'level', rms: level })
      },
      onError: (error) => {
        missedBuzz()
        respond({
          kind: 'blocked',
          text:
            error === 'voice needs Deepgram key'
              ? error
              : error === 'not-allowed' || error === 'service-not-allowed'
                ? 'mic blocked — allow the microphone for this site, then hold A again'
                : error === 'network'
                  ? 'lost the mic link — hold A to try again'
                  : `voice error: ${error}`,
        })
      },
      onFinal: (transcript) => {
        const line = transcript.trim()
        if (!line) {
          respond({ kind: 'missed' })
          return
        }
        noteCoachAction('talk')
        noteAmbientCommand(performance.now())
        const commandId = newCommandId()
        respond({ kind: 'working', on: true })
        thinkingLine = line
        void submitDirectorCommand(transcript, {
          forceVision: true,
          commandId,
          onNoResponse: () => {
            thinkingLine = null
            respond({ kind: 'working', on: false })
            respond({ kind: 'blocked', text: 'no response' })
          },
        }).then((result) => {
          if (result.offline) {
            thinkingLine = null
            respond({ kind: 'working', on: false })
            respond({ kind: 'offline', on: true })
            respond({ kind: 'status', text: line || 'offline' })
          } else if (result.ok && result.local) {
            // Local commands apply instantly — no crew round-trip to wait on,
            // so the change itself is the acknowledgement.
            thinkingLine = null
            respond({ kind: 'landed', objectId: null })
          } else if (result.ok) {
            respond({ kind: 'offline', on: false })
            // Stay working until the first crew packet or reply lands
            // (routed via the socket listeners above).
          }
        }).catch(() => {
          thinkingLine = null
          respond({ kind: 'working', on: false })
          respond({ kind: 'blocked', text: 'command failed' })
        })
      },
    }).catch((e) => {
      console.warn('[xr] voice session failed to start:', e)
      respond({ kind: 'blocked', text: 'voice error' })
    })
  }

  function endTalk(): void {
    // Graceful finish: the final transcript lands *after* release, so keep
    // handlers alive while it drains.
    if (!isVoiceListening()) {
      // The press never opened a session (still connecting, or it failed). Say
      // so rather than swallowing the gesture — an unacknowledged button is
      // indistinguishable from a broken one.
      // Nothing was captured, so no send whoosh — the buzz is the whole answer.
      missedBuzz()
      respond({ kind: 'heard', on: false, silent: true })
      return
    }
    pulse(padRef, 0.2, 20)
    // The room stops listening the instant the button comes up — and starts
    // working in the same beat, because it genuinely is: the transcript is
    // draining. Without this the ring fell to neutral for the 150-500ms until
    // the final landed and then lit blue, which reads as a flicker rather than
    // as one surface changing what it is doing.
    respond({ kind: 'heard', on: false })
    respond({ kind: 'working', on: true })
    directorSlate.setSending(lastInterim.trim())
    finishVoiceSession()
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

    // Gentle breathing pulse so the baked REC dot reads as live (no hard blink).
    if (takeLabel && isRolling) {
      ;(takeLabel.material as THREE.MeshBasicMaterial).opacity =
        0.75 + 0.25 * Math.sin(performance.now() * 0.006)
    }
  }

  function update(delta: number, timeSec: number, xrManager: THREE.WebXRManager): void {
    xrInput.update(xrManager, delta, timeSec)
    setEditorLayer(xrInput.xrOrigin)

    // Entry waits for real head tracking: place the stage ahead of the user,
    // then roll the cinematic (ripple/title read the freshly placed stage).
    if (pendingEntry) {
      const { pos, forward } = readHeadPose()
      const valid = isHeadPoseValid(pos)
      pendingEntrySec += delta
      // Waiting on a head pose that may never come. Seated at the origin, or
      // tracking lost at start, and this gate simply never opened: no stage, no
      // cinematic, no coach, and — worst of all — no message. Enter anyway on a
      // guessed forward, because a set placed imperfectly is recoverable ("crew,
      // set the stage" re-places it) and a silent dead end is not.
      if (valid || pendingEntrySec > ENTRY_POSE_TIMEOUT_SEC) {
        pendingEntry = false
        const standoff = standoffForThisDirector()
        const head: V3 = valid ? pos : [0, 1.6, 0]
        const position = computeStagePose(head, forward, standoff).position
        useEditorStore.getState().relocateStage(position)
        noteSessionStart()
        startEntrySequence()
        startXrCoach(timeSec * 1000)
        if (!valid) {
          respond({ kind: 'status', text: 'no head tracking yet — say “crew, set the stage” to place it' })
        } else if (useEditorStore.getState().xrBlendOpaque) {
          respond({ kind: 'status', text: 'VR mode — no passthrough here' })
        }
      }
    }

    const pad = xrInput.gamepads.right
    padRef = pad ?? null

    // Right controller is the whole rig — say so when it goes missing
    // (hands, left-only, tracking loss) instead of silently freezing.
    if (!pad) {
      padMissingSec += delta
      if (padMissingSec > 1.5 && !controllerNoticeShown) {
        controllerNoticeShown = true
        respond({ kind: 'notice', text: 'pick up the right controller' })
      }
    } else {
      padMissingSec = 0
      if (controllerNoticeShown) {
        controllerNoticeShown = false
        respond({ kind: 'notice', text: null })
        beatTick()
      }
    }

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
    directorSlate.update(timeSec * 1000)

    const grip = xrInput.xrOrigin.gripSpaces.right
    grip.updateWorldMatrix(true, false)
    grip.matrixWorld.decompose(worldPos, worldQuat, scratchScale)
    // Grip −Z + AIM_UP_DEG pitch (natural hold aims slightly above the barrel).
    aimQuat.copy(worldQuat).multiply(AIM_OFFSET)
    worldPos.add(scratchOffset.copy(lensOffset).applyQuaternion(aimQuat))

    const nowMs = timeSec * 1000
    // Read the director: settled or roaming, how long since they last said
    // anything. Drives the coach's patience and when a proposal is allowed
    // to surface. Aim-dwell focus is gone with the controller pointer.
    updateAmbientSense(nowMs, delta, xrInput.xrOrigin.head, grip, null)
    const ambient = getAmbientSignals()
    setCoachHesitation(ambient.hesitation)
    sampleWorkingDistance(nowMs, ambient.stillness)
    // The room breathes with you: settle and it deepens around the set; move
    // with intent and it lifts.
    setRoomStillness(ambient.stillness)

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
    // First boot: entering XR is an event — but the cinematic (and stage
    // placement) wait for the first tracked head pose in update().
    bindSession: () => {
      pendingEntry = true
      pendingEntrySec = 0
    },
    setTakeEndedHandler: (fn) => {
      onTakeEnded = fn
    },
    setSuppressRec: (fn) => {
      suppressRec = fn
    },
    dispose: () => {
      offSlateLog()
      offSlatePacket()
      registerStagePlacer(null)
      stopXrCoach()
      resetAmbientChannel()
      resetAmbientSense()
      retireAllCursors()
      bindAmbientChannel(null)
      stopVoiceSession()
      directorSlate.dispose()
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
