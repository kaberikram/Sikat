import * as THREE from 'three'
import { InputComponent, type XRInputManager } from '@iwsdk/xr-input'
import { createViewfinderComposer } from '../../pip-composer'
import { useEditorStore, type MotionObject, type PostProcessingStack } from '../../store'
import { applyVirtualCameraAtTime } from '../../timeline-apply'
import {
  createViewfinderBackdropMesh,
  setEditorLayer,
  tagSceneInfrastructure,
  VIEWFINDER_BACKDROP_LAYER,
} from '../infrastructure'
import { replyChime } from '../../director/sound'
import { renderViewfinderToTarget } from '../viewfinder-pass'
import { pulse } from './haptics'
import { registerReviewRecall } from './xr-bridge'
import {
  makeButtonTexture,
  makeCanvasTexture,
  makePlayheadTexture,
  makeReviewCardTexture,
  makeScrubTrackTexture,
  makeTitleTexture,
  XR_FONT_MONO,
  XR_UI,
} from './xr-ui-chrome'

/** World sizes — card includes chrome; film is inset 16:9. */
const CARD_W = 1.35
const CARD_H = 1.01
const FILM_W = 1.12
const FILM_H = FILM_W * (9 / 16)
const FILM_Y = 0.08
const DOCK_Y = -CARD_H / 2 + 0.12
const PLACE_DIST = 1.8
const REVIEW_RT_W = 960
const REVIEW_RT_H = 540
const MIN_SCALE = 0.5
const MAX_SCALE = 2.5
const SCRUB_W = 0.72
const SCRUB_H = 0.045
const B_HOLD_MS = 400
const STICK_DEADZONE = 0.15
/** At full stick, scrub through one take-length per second (min 0.5s/s). */
const SCRUB_RATE_MIN = 0.5
/** Stick Y while squeezing — scale factor per second at full deflection. */
const SCALE_RATE = 1.2

export interface ReviewScreen {
  group: THREE.Group
  isOpen: () => boolean
  showAfterTake: (takeStart: number, takeEnd: number, head: THREE.Object3D) => void
  hide: () => void
  update: (xrInput: XRInputManager) => void
  renderPlayback: (ctx: {
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    objects: MotionObject[]
    stack: PostProcessingStack
    delta: number
    t: number
    clearColor: string
    isObjectGizmoActive: (obj: MotionObject) => boolean
  }) => void
  dispose: () => void
}

function texturedPlane(
  w: number,
  h: number,
  tex: THREE.Texture,
  opts: { transparent?: boolean } = {}
): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: opts.transparent ?? true,
    toneMapped: false,
    side: THREE.DoubleSide,
    depthTest: true,
  })
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
}

function makeDockLegendTexture(): THREE.CanvasTexture {
  return makeCanvasTexture(1400, 120, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(59, 58, 72, 0.55)'
    ctx.beginPath()
    ctx.roundRect(8, 8, w - 16, h - 16, (h - 16) / 2)
    ctx.fill()
    ctx.fillStyle = XR_UI.paper
    ctx.font = XR_FONT_MONO
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('HOLD B CLOSE  ·  STICK SCRUB', w / 2, h / 2 + 2)
  })
}

export function createReviewScreen(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  cameraFar: number
): ReviewScreen {
  const group = new THREE.Group()
  group.visible = false
  tagSceneInfrastructure(group)
  setEditorLayer(group)
  scene.add(group)

  const playbackCam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, cameraFar)
  playbackCam.layers.set(0)
  playbackCam.layers.enable(VIEWFINDER_BACKDROP_LAYER)

  // Same physical backdrop as the grip LCD — see createViewfinderBackdropMesh.
  const playbackBackdrop = createViewfinderBackdropMesh(cameraFar * 0.9)
  playbackCam.add(playbackBackdrop)

  const viewfinder = createViewfinderComposer(
    scene,
    playbackCam,
    renderer,
    renderer.getPixelRatio()
  )

  const target = new THREE.WebGLRenderTarget(REVIEW_RT_W, REVIEW_RT_H, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
  })

  // Glass card — soft shadow + rounded screen bezel are baked into the texture.
  const cardTex = makeReviewCardTexture()
  const card = texturedPlane(CARD_W, CARD_H, cardTex)
  card.position.z = 0
  group.add(card)

  // Title chip only here (not baked into cardTex — that caused double text).
  const titleTex = makeTitleTexture('take review')
  const titleChip = texturedPlane(0.48, 0.09, titleTex)
  titleChip.position.set(-0.38, CARD_H / 2 - 0.1, 0.008)
  group.add(titleChip)

  const screenMat = new THREE.MeshBasicMaterial({
    map: target.texture,
    toneMapped: false,
    side: THREE.FrontSide,
  })
  const screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(FILM_W, FILM_H), screenMat)
  screenMesh.position.set(0, FILM_Y, 0.01)
  group.add(screenMesh)

  // Transport dock — status chrome only (buttons drive play/scrub/close).
  const playTex = makeButtonTexture('play', { bg: XR_UI.ink, fg: '#ffffff' })
  const pauseTex = makeButtonTexture('pause', { bg: XR_UI.chip, fg: XR_UI.ink })
  const playMat = new THREE.MeshBasicMaterial({
    map: playTex,
    transparent: true,
    toneMapped: false,
    side: THREE.DoubleSide,
  })
  const playBtn = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.112), playMat)
  playBtn.position.set(-0.5, DOCK_Y, 0.02)
  group.add(playBtn)

  const scrubTex = makeScrubTrackTexture()
  const scrubTrack = texturedPlane(SCRUB_W, SCRUB_H, scrubTex)
  scrubTrack.position.set(0.08, DOCK_Y, 0.02)
  group.add(scrubTrack)

  const playheadTex = makePlayheadTexture()
  const scrubThumb = texturedPlane(0.055, 0.055, playheadTex)
  scrubThumb.position.set(0.08 - SCRUB_W / 2, DOCK_Y, 0.03)
  group.add(scrubThumb)

  const legendTex = makeDockLegendTexture()
  const legend = texturedPlane(0.7, 0.07, legendTex)
  legend.position.set(0.3, CARD_H / 2 - 0.1, 0.02)
  group.add(legend)

  setEditorLayer(group)

  const grabOffset = new THREE.Vector3()
  const worldPos = new THREE.Vector3()
  const worldQuat = new THREE.Quaternion()
  const forward = new THREE.Vector3()

  let open = false
  let takeStart = 0
  let takeEnd = 0
  let dragging: 'move' | null = null
  let bDownAt: number | null = null
  let bHoldFired = false
  let lastUpdateMs = performance.now()

  function isOpen(): boolean {
    return open
  }

  function resetReviewInput(): void {
    dragging = null
    bDownAt = null
    bHoldFired = false
  }

  function hide(): void {
    open = false
    group.visible = false
    resetReviewInput()
    useEditorStore.getState().setPlayOnceEnd(null)
    if (useEditorStore.getState().isPlaying) useEditorStore.getState().togglePlay()
  }

  let lastHead: THREE.Object3D | null = null

  function placeInFrontOfHead(head: THREE.Object3D): void {
    head.updateWorldMatrix(true, false)
    head.getWorldPosition(worldPos)
    head.getWorldQuaternion(worldQuat)
    forward.set(0, 0, -1).applyQuaternion(worldQuat)
    group.position.copy(worldPos).addScaledVector(forward, PLACE_DIST)
    group.quaternion.copy(worldQuat)
  }

  function showAfterTake(start: number, end: number, head: THREE.Object3D): void {
    takeStart = start
    takeEnd = Math.max(end, start + 0.05)
    open = true
    group.visible = true
    group.scale.setScalar(1)
    lastHead = head
    resetReviewInput()

    placeInFrontOfHead(head)
    // A small "look here" chime — the monitor spawns outside the viewfinder
    // the user was just staring at.
    replyChime()

    const st = useEditorStore.getState()
    st.setTime(takeStart)
    st.setPlayOnceEnd(takeEnd)
    if (!st.isPlaying) st.togglePlay()
  }

  // Voice cue "where's the monitor" — re-place the open card in front of the head.
  registerReviewRecall(() => {
    if (!open || !lastHead) return false
    placeInFrontOfHead(lastHead)
    replyChime()
    return true
  })

  function syncScrubThumb(): void {
    const { currentTime } = useEditorStore.getState()
    const span = Math.max(takeEnd - takeStart, 0.001)
    const u = THREE.MathUtils.clamp((currentTime - takeStart) / span, 0, 1)
    scrubThumb.position.x = scrubTrack.position.x - SCRUB_W / 2 + u * SCRUB_W
  }

  function syncPlayLabel(): void {
    const playing = useEditorStore.getState().isPlaying
    playMat.map = playing ? pauseTex : playTex
    playMat.needsUpdate = true
  }

  function update(xrInput: XRInputManager): void {
    if (!open) return

    const now = performance.now()
    const dt = Math.min((now - lastUpdateMs) / 1000, 0.1)
    lastUpdateMs = now

    syncScrubThumb()
    syncPlayLabel()

    const pad = xrInput.gamepads.right
    const squeezeDown = Boolean(pad?.getButtonDown(InputComponent.Squeeze))
    const squeezeHeld = Boolean(pad?.getButtonPressed(InputComponent.Squeeze))
    const squeezeUp = Boolean(pad?.getButtonUp(InputComponent.Squeeze))

    // B tap = play/pause; hold B = close.
    if (pad?.getButtonDown(InputComponent.B_Button)) {
      bDownAt = now
      bHoldFired = false
    }
    if (pad?.getButtonPressed(InputComponent.B_Button) && bDownAt !== null && !bHoldFired) {
      if (now - bDownAt >= B_HOLD_MS) {
        bHoldFired = true
        pulse(pad, 0.35, 30)
        hide()
        return
      }
    }
    if (pad?.getButtonUp(InputComponent.B_Button)) {
      if (!bHoldFired && bDownAt !== null) {
        pulse(pad, 0.3, 25)
        useEditorStore.getState().togglePlay()
        syncPlayLabel()
      }
      bDownAt = null
      bHoldFired = false
    }

    const axes = pad?.getAxesValues(InputComponent.Thumbstick)
    const stickX = axes && Math.abs(axes.x) > STICK_DEADZONE ? axes.x : 0
    const stickY = axes && Math.abs(axes.y) > STICK_DEADZONE ? axes.y : 0

    // Scrub only when not grabbing — squeeze + stick Y owns scale.
    if (!squeezeHeld && stickX !== 0) {
      const span = Math.max(takeEnd - takeStart, SCRUB_RATE_MIN)
      const st = useEditorStore.getState()
      const next = THREE.MathUtils.clamp(st.currentTime + stickX * span * dt, takeStart, takeEnd)
      st.setTime(next)
      if (st.isPlaying) st.togglePlay()
      syncScrubThumb()
    }

    if (squeezeDown) {
      pulse(pad, 0.2, 20)
      dragging = 'move'
      const grip = xrInput.xrOrigin.gripSpaces.right
      grip.getWorldPosition(worldPos)
      grabOffset.copy(group.position).sub(worldPos)
    }

    if (dragging === 'move' && squeezeHeld) {
      const grip = xrInput.xrOrigin.gripSpaces.right
      grip.getWorldPosition(worldPos)
      group.position.copy(worldPos).add(grabOffset)
      if (stickY !== 0) {
        // Quest: stick forward is typically −Y — push forward to grow.
        const next = THREE.MathUtils.clamp(
          group.scale.x * (1 - stickY * SCALE_RATE * dt),
          MIN_SCALE,
          MAX_SCALE
        )
        group.scale.setScalar(next)
      }
    }

    if (squeezeUp) dragging = null
  }

  function renderPlayback(ctx: {
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    objects: MotionObject[]
    stack: PostProcessingStack
    delta: number
    t: number
    clearColor: string
    isObjectGizmoActive: (obj: MotionObject) => boolean
  }): void {
    if (!open) return
    const vc = useEditorStore.getState().virtualCamera
    applyVirtualCameraAtTime(ctx.t, vc, playbackCam)
    ;(playbackBackdrop.material as THREE.MeshBasicMaterial).color.set(ctx.clearColor)
    renderViewfinderToTarget({
      objects: ctx.objects,
      stack: ctx.stack,
      renderer: ctx.renderer,
      scene: ctx.scene,
      virtCamera: playbackCam,
      viewfinder,
      target,
      width: REVIEW_RT_W,
      height: REVIEW_RT_H,
      delta: ctx.delta,
      t: ctx.t,
      isObjectGizmoActive: ctx.isObjectGizmoActive,
      clearColor: ctx.clearColor,
    })
  }

  function disposeMesh(mesh: THREE.Mesh, disposeMap = true): void {
    mesh.geometry.dispose()
    const mat = mesh.material as THREE.MeshBasicMaterial
    if (disposeMap) mat.map?.dispose()
    mat.dispose()
  }

  function dispose(): void {
    registerReviewRecall(null)
    hide()
    scene.remove(group)
    target.dispose()
    disposeMesh(card)
    disposeMesh(titleChip)
    screenMesh.geometry.dispose()
    screenMat.dispose()
    playMat.map = null
    disposeMesh(playBtn, false)
    playTex.dispose()
    pauseTex.dispose()
    disposeMesh(scrubTrack)
    disposeMesh(scrubThumb)
    disposeMesh(legend)
    playbackBackdrop.geometry.dispose()
    ;(playbackBackdrop.material as THREE.Material).dispose()
    viewfinder.pixelatedPass.dispose()
    viewfinder.bloomPass.dispose()
    viewfinder.ditherPass.dispose()
    viewfinder.outputPass.dispose()
    viewfinder.composer.dispose()
  }

  return {
    group,
    isOpen,
    showAfterTake,
    hide,
    update,
    renderPlayback,
    dispose,
  }
}
