import * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { useEditorStore, VIRTUAL_CAMERA_ID } from '../store'
import { applyObjectTransformAtTime, applyVirtualCameraAtTime, applyVirtualCameraBase } from '../timeline-apply'
import { renderViewfinderPass } from './viewfinder-pass'
import { ensureShadowsOnObjectMeshes } from './shadows'
import { updateStageMarker } from './stage-marker'
import { updateEntrySequence } from './xr/entry-sequence'
import type { createViewfinderComposer } from '../pip-composer'
import type { AgentCursors } from './agent-cursors'
import type { CamcorderRig } from './xr/camcorder-rig'
import type { ReviewScreen } from './xr/review-screen'
import { syncXrStereoLayers } from './xr/xr-session'
import type { XrViewfinder } from './xr/xr-viewfinder'

type ViewfinderComposer = ReturnType<typeof createViewfinderComposer>

export function createAnimateLoop(ctx: {
  scene: THREE.Scene
  userCamera: THREE.PerspectiveCamera
  virtCamera: THREE.PerspectiveCamera
  mainRenderer: THREE.WebGLRenderer
  pipRenderer: THREE.WebGLRenderer
  viewfinder: ViewfinderComposer
  controls: OrbitControls
  transformControl: TransformControls
  ambientLight: THREE.AmbientLight
  directionalLight: THREE.DirectionalLight
  agentCursors: AgentCursors
  stageMarker: THREE.Group
  camcorderRig: CamcorderRig
  xrViewfinder: XrViewfinder
  reviewScreen: ReviewScreen
  virtCamBackdrop: THREE.Mesh
}) {
  let lastGizmoObject: THREE.Object3D | null = null
  let lastTime = performance.now()

  // User-camera fly cue (e.g. SET DAY pulling the viewport back to a wide
  // shot). The loop owns OrbitControls, so the tween lives here; grabbing the
  // orbit mid-flight cancels it — the user always wins.
  let cameraCueNonce = 0
  let cameraCue: {
    fromPos: THREE.Vector3
    toPos: THREE.Vector3
    fromTarget: THREE.Vector3
    toTarget: THREE.Vector3
    elapsed: number
    duration: number
  } | null = null
  const cancelCameraCue = () => {
    cameraCue = null
  }
  ctx.controls.addEventListener('start', cancelCameraCue)

  const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

  const frame = (now: number, xrFrame?: XRFrame) => {
    const delta = (now - lastTime) / 1000
    lastTime = now

    const { isPlaying, isRolling, cameraOpMode, xrActive } = useEditorStore.getState()
    if (isPlaying) {
      useEditorStore.setState((state) => {
        const nextTime = state.currentTime + delta
        if (state.isRolling) {
          return {
            currentTime: nextTime,
            duration: Math.max(state.duration, nextTime),
          }
        }
        if (state.playOnceEnd != null) {
          if (nextTime >= state.playOnceEnd) {
            return { currentTime: state.playOnceEnd, isPlaying: false, playOnceEnd: null }
          }
          return { currentTime: nextTime }
        }
        const loopAt = state.clipLoopEnd ?? state.duration
        if (state.playbackLoop) {
          return { currentTime: nextTime % loopAt }
        }
        if (nextTime >= loopAt) {
          return { currentTime: loopAt, isPlaying: false }
        }
        return { currentTime: nextTime }
      })
    }
    const t = useEditorStore.getState().currentTime
    const gizmo = ctx.transformControl
    if (useEditorStore.getState().isExporting) {
      return
    }

    const stack = useEditorStore.getState().virtualCamera.postProcessing
    const liveObjects = useEditorStore.getState().objects
    const selectedId = useEditorStore.getState().selectedId
    const vcamData = useEditorStore.getState().virtualCamera
    const lighting = useEditorStore.getState().lighting
    const liveCamOp = cameraOpMode || isRolling

    ctx.controls.enabled = !cameraOpMode && !xrActive

    ctx.ambientLight.color.set(lighting.ambient.color)
    ctx.ambientLight.intensity = lighting.ambient.intensity
    ctx.directionalLight.color.set(lighting.key.color)
    ctx.directionalLight.intensity = lighting.key.intensity
    ctx.directionalLight.position.set(...lighting.key.position)
    ;(ctx.virtCamBackdrop.material as THREE.MeshBasicMaterial).color.set(lighting.background)
    if (!xrActive) {
      if (!(ctx.scene.background instanceof THREE.Color)) {
        ctx.scene.background = new THREE.Color()
      }
      ctx.scene.background.set(lighting.background)
    }

    if (xrActive) {
      gizmo.enabled = false
      gizmo.detach()
      lastGizmoObject = null
    } else if (selectedId === VIRTUAL_CAMERA_ID) {
      gizmo.enabled = true
      if (lastGizmoObject !== ctx.virtCamera) {
        gizmo.attach(ctx.virtCamera)
        lastGizmoObject = ctx.virtCamera
      }
    } else {
      const selected = liveObjects.find((o) => o.id === selectedId)
      gizmo.enabled = true
      if (selected?.mesh) {
        if (lastGizmoObject !== selected.mesh) {
          gizmo.attach(selected.mesh)
          lastGizmoObject = selected.mesh
        }
      } else {
        gizmo.enabled = false
        gizmo.detach()
        lastGizmoObject = null
      }
    }

    const gizmoCamDrag = gizmo.dragging && gizmo.object === ctx.virtCamera
    if (!gizmoCamDrag) {
      const skipLiveCamApply = xrActive && xrFrame != null
      if (liveCamOp) {
        if (!skipLiveCamApply) applyVirtualCameraBase(vcamData, ctx.virtCamera)
      } else {
        applyVirtualCameraAtTime(t, vcamData, ctx.virtCamera)
      }
    }

    for (const obj of liveObjects) {
      if (!obj.mesh) continue
      const gizmoObj = gizmo.dragging && gizmo.object === obj.mesh
      if (!gizmoObj) applyObjectTransformAtTime(t, obj)
      if (!ctx.scene.children.includes(obj.mesh)) ctx.scene.add(obj.mesh)
    }

    ctx.agentCursors.update(now)
    updateStageMarker(ctx.stageMarker)

    const cueRequest = useEditorStore.getState().userCameraCue
    if (cueRequest && cueRequest.nonce !== cameraCueNonce) {
      cameraCueNonce = cueRequest.nonce
      if (!xrActive) {
        cameraCue = {
          fromPos: ctx.userCamera.position.clone(),
          toPos: new THREE.Vector3(...cueRequest.position),
          fromTarget: ctx.controls.target.clone(),
          toTarget: new THREE.Vector3(...cueRequest.target),
          elapsed: 0,
          duration: Math.max(0.01, cueRequest.durationSec),
        }
      }
    }
    if (cameraCue && !xrActive && !cameraOpMode) {
      cameraCue.elapsed += delta
      const alpha = easeInOut(Math.min(1, cameraCue.elapsed / cameraCue.duration))
      ctx.userCamera.position.lerpVectors(cameraCue.fromPos, cameraCue.toPos, alpha)
      ctx.controls.target.lerpVectors(cameraCue.fromTarget, cameraCue.toTarget, alpha)
      if (alpha >= 1) cameraCue = null
    }

    if (!xrActive) ctx.controls.update()

    if (xrActive && xrFrame) {
      // Eye cameras can appear after sessionstart — keep layer 1 (viewfinder) on both eyes.
      syncXrStereoLayers(ctx.mainRenderer)

      // Hide virt-cam axes in XR (they sit at the lens and look like a stray gizmo).
      // Keep the studio backdrop mesh visible — WebXR alpha-blend sessions force
      // offscreen clears to transparent black, so scene.background / setClearColor
      // alone can't paint the LCD; the backdrop sphere is the opaque #f2f2f2 stand-in.
      for (const child of ctx.virtCamera.children) {
        child.visible = child === ctx.virtCamBackdrop
      }
      // IWSDK updates grip/ray spaces; camcorder pose + REC read from gripSpaces.right.
      ctx.camcorderRig.update(delta, now / 1000, ctx.mainRenderer.xr)
      updateEntrySequence(now, delta)

      // Fixed RT size — desktop PiP is sr-only in XR (often 1×1), which made the LCD black.
      const XR_VF_W = 640
      const XR_VF_H = 360
      ctx.xrViewfinder.render({
        renderer: ctx.mainRenderer,
        scene: ctx.scene,
        virtCamera: ctx.virtCamera,
        screenMesh: ctx.camcorderRig.screenMesh,
        objects: liveObjects,
        stack,
        width: XR_VF_W,
        height: XR_VF_H,
        delta,
        t,
        isObjectGizmoActive: (obj) => gizmo.dragging && gizmo.object === obj.mesh,
        clearColor: lighting.background,
      })

      // Review monitor: timeline camera playback (separate from live grip LCD).
      if (ctx.reviewScreen.isOpen()) {
        ctx.reviewScreen.update(ctx.camcorderRig.xrInput)
        ctx.reviewScreen.renderPlayback({
          renderer: ctx.mainRenderer,
          scene: ctx.scene,
          objects: liveObjects,
          stack,
          delta,
          t,
          clearColor: lighting.background,
          isObjectGizmoActive: (obj) => gizmo.dragging && gizmo.object === obj.mesh,
        })
      }

      // Headset view: passthrough / transparent composite over the real world.
      // (Viewfinder already filmed studio CG above — passthrough is eyes only.)
      ctx.scene.background = null
    } else if (ctx.reviewScreen.isOpen()) {
      ctx.reviewScreen.hide()
    }

    ctx.mainRenderer.render(ctx.scene, ctx.userCamera)

    if (!xrActive) {
      for (const child of ctx.virtCamera.children) child.visible = true
      renderViewfinderPass({
        objects: liveObjects,
        stack,
        pipRenderer: ctx.pipRenderer,
        scene: ctx.scene,
        virtCamera: ctx.virtCamera,
        viewfinder: ctx.viewfinder,
        delta,
        t,
        vcData: vcamData,
        isObjectGizmoActive: (obj) => gizmo.dragging && gizmo.object === obj.mesh,
        skipCameraApply: gizmoCamDrag || liveCamOp,
      })
    }
  }

  // A throw inside setAnimationLoop's callback permanently stops the rAF chain
  // (in XR that freezes the headset on the last frame). Guard every frame so a
  // bad frame drops instead of killing the loop; bail out only if the loop is
  // failing continuously with no recovery.
  let consecutiveErrors = 0
  let lastErrorLog = 0
  const MAX_CONSECUTIVE_ERRORS = 120

  const animate = (now: number, xrFrame?: XRFrame) => {
    try {
      frame(now, xrFrame)
      consecutiveErrors = 0
    } catch (e) {
      consecutiveErrors += 1
      if (now - lastErrorLog > 5000 || consecutiveErrors === 1) {
        lastErrorLog = now
        console.error(`[animate] frame error (${consecutiveErrors} consecutive):`, e)
      }
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error('[animate] too many consecutive frame errors — stopping render loop')
        ctx.mainRenderer.setAnimationLoop(null)
        useEditorStore.getState().setFatalRenderError(true)
      }
    }
  }

  ctx.mainRenderer.setAnimationLoop(animate)
  return () => {
    ctx.controls.removeEventListener('start', cancelCameraCue)
    ctx.mainRenderer.setAnimationLoop(null)
  }
}

export function subscribeShadowSync() {
  let lastObjects: unknown = null
  let lastSig = ''
  return useEditorStore.subscribe((state) => {
    // This fires on every store change (60fps during playback) — skip the
    // JSON signature work unless the objects array itself changed.
    if (state.objects === lastObjects) return
    lastObjects = state.objects
    const sig = state.objects.map((o) => o.id).join(',') + JSON.stringify(state.objects.map((o) => o.subMeshShadow))
    if (sig === lastSig) return
    lastSig = sig
    ensureShadowsOnObjectMeshes(state.objects)
  })
}
