import * as THREE from 'three'
import { useEditorStore } from '../../store'
import { releaseVoiceCapture, stopVoiceSession } from '../../director/voice-session'
import { retireAllCursors } from '../../director/agent-runtime'
import { abandonDemo } from '../../director/demo-shoot'
import { clearAllGhosts } from '../../director/ghost-preview'
import { clearProposal } from '../../director/proposal-ghost'
import { EDITOR_LAYER } from '../infrastructure'
import { clearAttention } from './attention-field'
import { resetAmbientChannel } from './ambient-channel'
import { resetAmbientSense } from './ambient-sense'
import { stopXrCoach } from './xr-coach'
import { disposeEntrySequence } from './entry-sequence'
import { registerXrSessionEntry, registerXrSessionExit } from './xr-bridge'
import type { CamcorderRig } from './camcorder-rig'
import { forceLegacyXrLayerIfNeeded } from './xr-compat'

/**
 * Ensure editor chrome (EDITOR_LAYER) is visible in both eyes.
 * Three.js `updateCamera` copies `userCamera.layers` then ORs eye bits 1|2 —
 * so userCamera must already enable EDITOR_LAYER (see bootstrap). This re-asserts
 * after eye cameras are created.
 */
export function syncXrStereoLayers(renderer: THREE.WebGLRenderer): void {
  const xrCam = renderer.xr.getCamera()
  xrCam.layers.enable(0)
  xrCam.layers.enable(EDITOR_LAYER)
  for (const cam of xrCam.cameras) {
    cam.layers.enable(0)
    cam.layers.enable(EDITOR_LAYER)
  }
}

async function requestImmersiveSession(): Promise<XRSession> {
  if (!navigator.xr) throw new Error('WebXR not available')

  const modes: XRSessionMode[] = ['immersive-ar', 'immersive-vr']
  let lastError: unknown

  for (const mode of modes) {
    if (!(await navigator.xr.isSessionSupported(mode))) continue
    const featureSets: XRSessionInit[] = [
      { optionalFeatures: ['local-floor', 'hand-tracking'] },
      { optionalFeatures: ['local-floor'] },
      {},
    ]
    for (const init of featureSets) {
      try {
        return await navigator.xr.requestSession(mode, init)
      } catch (err) {
        lastError = err
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Could not start immersive XR session')
}

export function initXrSession(
  renderer: THREE.WebGLRenderer,
  rig: CamcorderRig
): () => void {
  renderer.xr.enabled = true

  // Stereo eye cameras are often empty at sessionstart and can reset masks —
  // also sync every frame from animate-loop via syncXrStereoLayers().
  renderer.xr.addEventListener('sessionstart', () => {
    syncXrStereoLayers(renderer)
  })

  let priorCameraOpMode = false
  let activeSession: XRSession | null = null

  async function enter(): Promise<void> {
    if (activeSession || !navigator.xr) return
    priorCameraOpMode = useEditorStore.getState().cameraOpMode
    const session = await requestImmersiveSession()
    activeSession = session
    // 'opaque' = no passthrough (immersive-vr fallback) — the rig tells the
    // user once so a black world reads as a mode, not a bug.
    useEditorStore.getState().setXrBlendOpaque(session.environmentBlendMode === 'opaque')
    forceLegacyXrLayerIfNeeded(session, renderer.getContext())
    await renderer.xr.setSession(session)
    rig.bindSession(session)
    useEditorStore.getState().setXrActive(true)
    useEditorStore.getState().setCameraOpMode(true)

    session.addEventListener('end', () => {
      activeSession = null
      stopVoiceSession()
      // The mic is held warm for the whole session — don't let the recording
      // indicator outlive it.
      releaseVoiceCapture()
      disposeEntrySequence()

      // Everything below used to live only in `camcorderRig.dispose()`, which
      // runs on scene teardown — not on session end. So a wrap left the next
      // session inheriting this one's state: a miss count, a pending reply
      // timer, a stale aimed object, a room possibly still lit as "listening"
      // because the headset came off mid-hold, and a proposal id that made
      // `hasLiveProposal()` lie. Ending a session now actually ends it.
      const store = useEditorStore.getState()
      // A take does not survive the headset coming off — nothing else stops it,
      // and `duration` would keep growing on the desktop timeline forever.
      if (store.isRolling) store.endTake()
      abandonDemo()
      retireAllCursors()
      clearAllGhosts()
      clearProposal()
      resetAmbientChannel()
      resetAmbientSense()
      clearAttention()
      stopXrCoach()

      // Carry the set back to world origin so desktop isn't left staring at
      // an empty ring while props sit at the last XR standoff.
      store.relocateStage([0, 0, 0])
      store.setXrActive(false)
      store.setCameraOpMode(priorCameraOpMode)
    })
  }

  async function exit(): Promise<void> {
    if (!activeSession) return
    try {
      await activeSession.end()
    } catch {
      // already ended
    }
  }

  registerXrSessionEntry(enter)
  registerXrSessionExit(exit)

  return () => {
    registerXrSessionEntry(null)
    registerXrSessionExit(null)
    activeSession?.end().catch(() => {})
  }
}
