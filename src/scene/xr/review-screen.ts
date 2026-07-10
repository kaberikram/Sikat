import * as THREE from 'three'
import { InputComponent, type XRInputManager } from '@iwsdk/xr-input'
import { createViewfinderComposer } from '../../pip-composer'
import { useEditorStore, type MotionObject, type PostProcessingStack } from '../../store'
import { applyVirtualCameraAtTime } from '../../timeline-apply'
import { setEditorLayer, tagSceneInfrastructure } from '../infrastructure'
import { renderViewfinderToTarget } from '../viewfinder-pass'
import {
  makeButtonTexture,
  makeCloseTexture,
  makePlayheadTexture,
  makeReviewCardTexture,
  makeScaleHandleTexture,
  makeScrubTrackTexture,
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

type HitKind = 'play' | 'scrub' | 'dismiss' | 'frame' | 'scale'

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

  const viewfinder = createViewfinderComposer(
    scene,
    playbackCam,
    renderer,
    renderer.getPixelRatio()
  )

  const target = new THREE.WebGLRenderTarget(REVIEW_RT_W, REVIEW_RT_H, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  })

  // Hard shadow plate (brutalist-shadow)
  const shadowPlate = new THREE.Mesh(
    new THREE.PlaneGeometry(CARD_W, CARD_H),
    new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide })
  )
  shadowPlate.position.set(0.035, -0.035, -0.012)
  group.add(shadowPlate)

  const cardTex = makeReviewCardTexture()
  const card = texturedPlane(CARD_W, CARD_H, cardTex, { transparent: false })
  card.position.z = 0
  card.userData.hitKind = 'frame' satisfies HitKind
  group.add(card)

  // Title chip only here (not baked into cardTex — that caused double text).
  const titleTex = makeButtonTexture('TAKE REVIEW', {
    bg: XR_UI.ink,
    fg: XR_UI.paper,
    w: 840,
    h: 144,
  })
  const titleChip = texturedPlane(0.42, 0.072, titleTex, { transparent: false })
  titleChip.position.set(-0.36, CARD_H / 2 - 0.09, 0.008)
  titleChip.rotation.z = (-2 * Math.PI) / 180
  group.add(titleChip)

  // Film bezel + RT screen
  const bezel = new THREE.Mesh(
    new THREE.PlaneGeometry(FILM_W + 0.04, FILM_H + 0.04),
    new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide })
  )
  bezel.position.set(0, FILM_Y, 0.004)
  group.add(bezel)

  const screenMat = new THREE.MeshBasicMaterial({
    map: target.texture,
    toneMapped: false,
    side: THREE.FrontSide,
  })
  const screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(FILM_W, FILM_H), screenMat)
  screenMesh.position.set(0, FILM_Y, 0.01)
  group.add(screenMesh)

  // Transport dock controls
  const playTex = makeButtonTexture('PLAY', { bg: XR_UI.ink, fg: XR_UI.paper })
  const pauseTex = makeButtonTexture('PAUSE', { bg: XR_UI.ink, fg: XR_UI.yellow })
  const playHoverTex = makeButtonTexture('PLAY', { bg: XR_UI.ink, fg: XR_UI.paper, hover: true })
  const pauseHoverTex = makeButtonTexture('PAUSE', { bg: XR_UI.ink, fg: XR_UI.yellow, hover: true })
  const playMat = new THREE.MeshBasicMaterial({
    map: playTex,
    transparent: true,
    toneMapped: false,
    side: THREE.DoubleSide,
  })
  const playBtn = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.07), playMat)
  playBtn.position.set(-0.42, DOCK_Y, 0.02)
  playBtn.userData.hitKind = 'play' satisfies HitKind
  group.add(playBtn)

  const scrubTex = makeScrubTrackTexture()
  const scrubTrack = texturedPlane(SCRUB_W, SCRUB_H, scrubTex)
  scrubTrack.position.set(0.08, DOCK_Y, 0.02)
  scrubTrack.userData.hitKind = 'scrub' satisfies HitKind
  group.add(scrubTrack)

  const playheadTex = makePlayheadTexture()
  const scrubThumb = texturedPlane(0.028, 0.06, playheadTex)
  scrubThumb.position.set(0.08 - SCRUB_W / 2, DOCK_Y, 0.03)
  group.add(scrubThumb)

  const dismissTex = makeCloseTexture(false)
  const dismissHoverTex = makeCloseTexture(true)
  const dismissMat = new THREE.MeshBasicMaterial({
    map: dismissTex,
    transparent: true,
    toneMapped: false,
    side: THREE.DoubleSide,
  })
  const dismissBtn = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.09), dismissMat)
  dismissBtn.position.set(CARD_W / 2 - 0.1, CARD_H / 2 - 0.1, 0.02)
  dismissBtn.userData.hitKind = 'dismiss' satisfies HitKind
  group.add(dismissBtn)

  const scaleTex = makeScaleHandleTexture()
  const scaleHandle = texturedPlane(0.08, 0.08, scaleTex)
  scaleHandle.position.set(CARD_W / 2 - 0.1, DOCK_Y, 0.02)
  scaleHandle.userData.hitKind = 'scale' satisfies HitKind
  group.add(scaleHandle)

  setEditorLayer(group)

  const raycaster = new THREE.Raycaster()
  const rayOrigin = new THREE.Vector3()
  const rayDir = new THREE.Vector3()
  const localHit = new THREE.Vector3()
  const grabOffset = new THREE.Vector3()
  const worldPos = new THREE.Vector3()
  const worldQuat = new THREE.Quaternion()
  const forward = new THREE.Vector3()
  const hitTargets: THREE.Object3D[] = [playBtn, scrubTrack, dismissBtn, card, scaleHandle]

  let open = false
  let takeStart = 0
  let takeEnd = 0
  let dragging: 'move' | 'scale' | 'scrub' | null = null
  let grabScale0 = 1
  let grabDist0 = 1
  let hoverKind: HitKind | null = null

  function isOpen(): boolean {
    return open
  }

  function hide(): void {
    open = false
    group.visible = false
    dragging = null
    hoverKind = null
    useEditorStore.getState().setPlayOnceEnd(null)
    if (useEditorStore.getState().isPlaying) useEditorStore.getState().togglePlay()
  }

  function showAfterTake(start: number, end: number, head: THREE.Object3D): void {
    takeStart = start
    takeEnd = Math.max(end, start + 0.05)
    open = true
    group.visible = true
    group.scale.setScalar(1)

    head.updateWorldMatrix(true, false)
    head.getWorldPosition(worldPos)
    head.getWorldQuaternion(worldQuat)
    forward.set(0, 0, -1).applyQuaternion(worldQuat)
    group.position.copy(worldPos).addScaledVector(forward, PLACE_DIST)
    group.quaternion.copy(worldQuat)

    const st = useEditorStore.getState()
    st.setTime(takeStart)
    st.setPlayOnceEnd(takeEnd)
    if (!st.isPlaying) st.togglePlay()
  }

  function syncScrubThumb(): void {
    const { currentTime } = useEditorStore.getState()
    const span = Math.max(takeEnd - takeStart, 0.001)
    const u = THREE.MathUtils.clamp((currentTime - takeStart) / span, 0, 1)
    scrubThumb.position.x = scrubTrack.position.x - SCRUB_W / 2 + u * SCRUB_W
  }

  function syncPlayLabel(): void {
    const playing = useEditorStore.getState().isPlaying
    const hovered = hoverKind === 'play'
    if (playing) playMat.map = hovered ? pauseHoverTex : pauseTex
    else playMat.map = hovered ? playHoverTex : playTex
    playMat.needsUpdate = true
  }

  function syncHoverChrome(): void {
    dismissMat.map = hoverKind === 'dismiss' ? dismissHoverTex : dismissTex
    dismissMat.needsUpdate = true
    syncPlayLabel()
  }

  function hitTest(xrInput: XRInputManager): { kind: HitKind; point: THREE.Vector3 } | null {
    const ray = xrInput.xrOrigin.raySpaces.right
    ray.updateWorldMatrix(true, false)
    ray.matrixWorld.decompose(rayOrigin, worldQuat, localHit)
    rayDir.set(0, 0, -1).applyQuaternion(worldQuat).normalize()
    raycaster.set(rayOrigin, rayDir)
    const hits = raycaster.intersectObjects(hitTargets, false)
    if (hits.length === 0) return null
    const kind = hits[0].object.userData.hitKind as HitKind | undefined
    if (!kind) return null
    return { kind, point: hits[0].point }
  }

  function seekFromPoint(point: THREE.Vector3): void {
    scrubTrack.worldToLocal(localHit.copy(point))
    const u = THREE.MathUtils.clamp((localHit.x + SCRUB_W / 2) / SCRUB_W, 0, 1)
    useEditorStore.getState().setTime(takeStart + u * (takeEnd - takeStart))
  }

  function update(xrInput: XRInputManager): void {
    if (!open) return

    syncScrubThumb()

    const pad = xrInput.gamepads.right
    const triggerDown = Boolean(
      pad && (pad.getButtonDown(InputComponent.Trigger) || pad.getSelectStart())
    )
    const squeezeDown = Boolean(pad?.getButtonDown(InputComponent.Squeeze))
    const squeezeHeld = Boolean(pad?.getButtonPressed(InputComponent.Squeeze))
    const squeezeUp = Boolean(pad?.getButtonUp(InputComponent.Squeeze))
    const triggerHeld = Boolean(
      pad && (pad.getButtonPressed(InputComponent.Trigger) || pad.getSelecting())
    )

    const hit = hitTest(xrInput)
    hoverKind = hit?.kind ?? null
    syncHoverChrome()

    if (triggerDown && hit) {
      if (hit.kind === 'play') {
        useEditorStore.getState().togglePlay()
      } else if (hit.kind === 'dismiss') {
        hide()
        return
      } else if (hit.kind === 'scrub') {
        dragging = 'scrub'
        seekFromPoint(hit.point)
      }
    }

    if (squeezeDown && hit) {
      if (hit.kind === 'scale') {
        dragging = 'scale'
        grabScale0 = group.scale.x
        const grip = xrInput.xrOrigin.gripSpaces.right
        grip.getWorldPosition(worldPos)
        grabDist0 = Math.max(0.05, worldPos.distanceTo(group.position))
      } else if (hit.kind === 'frame' || hit.kind === 'play' || hit.kind === 'scrub') {
        dragging = 'move'
        const grip = xrInput.xrOrigin.gripSpaces.right
        grip.getWorldPosition(worldPos)
        grabOffset.copy(group.position).sub(worldPos)
      }
    }

    if (dragging === 'scrub' && triggerHeld && hit?.kind === 'scrub') {
      seekFromPoint(hit.point)
    }

    if (dragging === 'move' && squeezeHeld) {
      const grip = xrInput.xrOrigin.gripSpaces.right
      grip.getWorldPosition(worldPos)
      group.position.copy(worldPos).add(grabOffset)
    }

    if (dragging === 'scale' && squeezeHeld) {
      const grip = xrInput.xrOrigin.gripSpaces.right
      grip.getWorldPosition(worldPos)
      const dist = Math.max(0.05, worldPos.distanceTo(group.position))
      const next = THREE.MathUtils.clamp(grabScale0 * (dist / grabDist0), MIN_SCALE, MAX_SCALE)
      group.scale.setScalar(next)
    }

    if (squeezeUp || (dragging === 'scrub' && pad?.getButtonUp(InputComponent.Trigger))) {
      dragging = null
    }
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
    hide()
    scene.remove(group)
    target.dispose()
    disposeMesh(shadowPlate)
    disposeMesh(card)
    disposeMesh(titleChip)
    disposeMesh(bezel)
    screenMesh.geometry.dispose()
    screenMat.dispose()
    playMat.map = null
    disposeMesh(playBtn, false)
    playTex.dispose()
    pauseTex.dispose()
    playHoverTex.dispose()
    pauseHoverTex.dispose()
    disposeMesh(scrubTrack)
    disposeMesh(scrubThumb)
    dismissMat.map = null
    disposeMesh(dismissBtn, false)
    dismissTex.dispose()
    dismissHoverTex.dispose()
    disposeMesh(scaleHandle)
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
