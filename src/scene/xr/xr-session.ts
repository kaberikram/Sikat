import * as THREE from 'three'
import { useEditorStore } from '../../store'
import { stopVoiceSession } from '../../director/voice-session'
import { EDITOR_LAYER } from '../infrastructure'
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
    forceLegacyXrLayerIfNeeded(session, renderer.getContext())
    await renderer.xr.setSession(session)
    rig.bindSession(session)
    useEditorStore.getState().setXrActive(true)
    useEditorStore.getState().setCameraOpMode(true)

    session.addEventListener('end', () => {
      activeSession = null
      stopVoiceSession()
      useEditorStore.getState().setXrActive(false)
      useEditorStore.getState().setCameraOpMode(priorCameraOpMode)
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
