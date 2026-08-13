/**
 * FIRST BOOT — the cinematic XR entry.
 *
 * Entering XR is an event: the room dims into shoot lighting, the stage ring
 * materializes with a ripple of light, a slow column of pastel motes rises,
 * and a title card drifts up in front of you. ~5s, self-cleaning, one extra
 * draw call (a single THREE.Points) — everything on EDITOR_LAYER so none of
 * it is ever filmed by the viewfinder.
 *
 * The dim dome persists after entry as the set's ambience (setRoomDim), and
 * fades out on session end / strike.
 */
import * as THREE from 'three'
import { entrySwell } from '../../director/sound'
import { useEditorStore } from '../../store'
import { setEditorLayer, tagSceneInfrastructure } from '../infrastructure'
import { respond } from './ambient-channel'
import { XR_UI, makeTitleTexture } from './xr-ui-chrome'

const PARTICLES = 250
const ENTRY_MS = 5000
/** Ambient dim the set keeps after the entry beat. */
const SET_DIM = 0.3

interface EntryRefs {
  scene: THREE.Scene
  head: THREE.Object3D
}

let refs: EntryRefs | null = null

/** True while this module is holding a room accent, so teardown releases it once. */
let holdingAccent = false

let dome: THREE.Mesh | null = null
let domeMat: THREE.MeshBasicMaterial | null = null
let ripple: THREE.Mesh | null = null
let rippleMat: THREE.MeshBasicMaterial | null = null
let points: THREE.Points | null = null
let pointsMat: THREE.PointsMaterial | null = null
let particleSeeds: Float32Array | null = null
let title: THREE.Mesh | null = null
let titleMat: THREE.MeshBasicMaterial | null = null

let running = false
let startedAt = 0
let dimTarget = 0
let dimLevel = 0
/**
 * The set's intended resting ambience. `setRoomDim` moves this; the room's
 * breathing rides on top via `setRoomDimOffset`. Keeping them apart is what
 * stops a per-frame modulation from undoing the strike's hard zero.
 */
let dimBase = 0
let dimOffset = 0

// One-shot "stage locks in" ripple — fired when the stage re-places mid-session.
let lockRipple: THREE.Mesh | null = null
let lockRippleMat: THREE.MeshBasicMaterial | null = null
let lockStartedAt = 0
const LOCK_PULSE_MS = 700

const easeOut = (t: number) => 1 - (1 - t) ** 3
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
/** 0→1→0 window between a and b with soft edges. */
function windowEnv(t: number, a: number, b: number, edge = 0.25): number {
  if (t <= a || t >= b) return 0
  const u = (t - a) / (b - a)
  return clamp01(Math.min(u / edge, (1 - u) / edge, 1))
}

export function initEntrySequence(scene: THREE.Scene, head: THREE.Object3D): void {
  refs = { scene, head }
}

/**
 * The stage ring belongs to room-response, and the *right* to tint it belongs to
 * the ambient channel. The entry beat files a claim like everything else rather
 * than writing the surface directly — it used to call setRoomAccent every frame
 * for ~3.7s, which overwrote any proposal that arrived during the cinematic and
 * then cleared that proposal's colour on release.
 */
function holdAccent(weight: number): void {
  holdingAccent = true
  respond({ kind: 'entryAccent', color: XR_UI.mintDeep, weight })
}

function releaseAccent(): void {
  if (!holdingAccent) return
  holdingAccent = false
  respond({ kind: 'entryAccent', color: XR_UI.mintDeep, weight: 0 })
}

function buildObjects(): void {
  if (!refs) return
  const { scene, head } = refs
  const stage = useEditorStore.getState().stage
  const [sx, sy, sz] = stage.position

  // Passthrough dim dome — follows the head, eyes-only.
  domeMat = new THREE.MeshBasicMaterial({
    color: '#171522',
    transparent: true,
    opacity: 0,
    side: THREE.BackSide,
    depthWrite: false,
  })
  dome = new THREE.Mesh(new THREE.SphereGeometry(6, 32, 16), domeMat)
  dome.renderOrder = -10
  tagSceneInfrastructure(dome)
  setEditorLayer(dome)
  head.add(dome)

  // One-shot ripple ring expanding from the stage.
  rippleMat = new THREE.MeshBasicMaterial({
    color: XR_UI.mintDeep,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  ripple = new THREE.Mesh(new THREE.RingGeometry(0.94, 1.0, 64), rippleMat)
  ripple.rotation.x = -Math.PI / 2
  ripple.position.set(sx, sy + 0.005, sz)
  ripple.renderOrder = 5
  tagSceneInfrastructure(ripple)
  setEditorLayer(ripple)
  scene.add(ripple)

  // Rising pastel motes — one Points draw call.
  const positions = new Float32Array(PARTICLES * 3)
  const colors = new Float32Array(PARTICLES * 3)
  particleSeeds = new Float32Array(PARTICLES * 2) // radius, phase
  const palette = [XR_UI.accent, XR_UI.mint, XR_UI.ink, XR_UI.wash].map((c) => new THREE.Color(c))
  for (let i = 0; i < PARTICLES; i++) {
    const r = 0.35 + Math.random() * (stage.radius + 0.4)
    const a = Math.random() * Math.PI * 2
    positions[i * 3] = sx + Math.cos(a) * r
    positions[i * 3 + 1] = sy + Math.random() * 1.5
    positions[i * 3 + 2] = sz + Math.sin(a) * r
    particleSeeds[i * 2] = 0.12 + Math.random() * 0.25 // rise speed m/s
    particleSeeds[i * 2 + 1] = Math.random() * Math.PI * 2
    const c = palette[i % palette.length]
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  pointsMat = new THREE.PointsMaterial({
    size: 0.012,
    vertexColors: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  points = new THREE.Points(geo, pointsMat)
  tagSceneInfrastructure(points)
  setEditorLayer(points)
  scene.add(points)

  // Title card — placed once in world space in front of the head.
  const tex = makeTitleTexture('SIKAT — ON SET', { w: 1024, h: 160 })
  titleMat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: 0,
    toneMapped: false,
    depthTest: false,
    side: THREE.DoubleSide,
  })
  title = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.14), titleMat)
  const headPos = new THREE.Vector3()
  const headQuat = new THREE.Quaternion()
  head.getWorldPosition(headPos)
  head.getWorldQuaternion(headQuat)
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(headQuat)
  title.position.copy(headPos).addScaledVector(forward, 1.4)
  title.position.y -= 0.08
  title.quaternion.copy(headQuat)
  title.renderOrder = 12
  tagSceneInfrastructure(title)
  setEditorLayer(title)
  scene.add(title)
}

export function startEntrySequence(): void {
  if (!refs || running) return
  disposeEntryObjects() // safety: re-entry after an earlier session
  buildObjects()
  running = true
  startedAt = performance.now()
  setRoomDim(SET_DIM)
  entrySwell()
}

/** Ambient room dim (0..1). The demo's strike and session end set 0. */
export function setRoomDim(level: number): void {
  dimBase = clamp01(level)
  dimTarget = clamp01(dimBase + dimOffset)
}

/**
 * A small additive nudge on top of the resting dim — the room settling with a
 * still director. Never moves the room off a hard zero, so a struck set stays
 * struck.
 */
export function setRoomDimOffset(offset: number): void {
  dimOffset = dimBase > 0 ? Math.max(0, offset) : 0
  dimTarget = clamp01(dimBase + dimOffset)
}

/** "Stage locks in" — a quick ripple at the (re-)placed stage position. */
export function playStageLockPulse(): void {
  if (!refs) return
  disposeMesh(lockRipple)
  const stage = useEditorStore.getState().stage
  lockRippleMat = new THREE.MeshBasicMaterial({
    color: XR_UI.mintDeep,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  lockRipple = new THREE.Mesh(new THREE.RingGeometry(0.94, 1.0, 64), lockRippleMat)
  lockRipple.rotation.x = -Math.PI / 2
  lockRipple.position.set(stage.position[0], stage.position[1] + 0.005, stage.position[2])
  lockRipple.renderOrder = 5
  tagSceneInfrastructure(lockRipple)
  setEditorLayer(lockRipple)
  refs.scene.add(lockRipple)
  lockStartedAt = performance.now()
}

export function updateEntrySequence(now: number, delta: number): void {
  // Dome ambience runs for the whole session, not just the entry beat.
  if (domeMat) {
    dimLevel += (dimTarget - dimLevel) * Math.min(1, delta * 3)
    domeMat.opacity = dimLevel
  }
  if (lockRipple && lockRippleMat) {
    const lt = (now - lockStartedAt) / LOCK_PULSE_MS
    if (lt >= 1) {
      disposeMesh(lockRipple)
      lockRipple = null
      lockRippleMat = null
    } else {
      const s = 1 + easeOut(lt) * 1.6
      lockRipple.scale.set(s, s, s)
      lockRippleMat.opacity = 0.5 * (1 - lt)
    }
  }

  if (!running || !refs) return

  const t = (now - startedAt) / ENTRY_MS // 0..1 over 5s

  // Beat 1 (0–1.2s): the room dims — dome eases toward an entry-deep 0.45
  // before settling at SET_DIM (handled by the damp above once we lower it).
  if (t < 0.24) setRoomDim(0.45 * easeOut(t / 0.24))
  else setRoomDim(SET_DIM)

  // Beat 2 (0.8–2.2s): stage ring materializes + ripple.
  const w = clamp01((t - 0.16) / 0.28)
  if (w > 0 && t < 0.9) holdAccent(easeOut(w))
  else if (t >= 0.9) releaseAccent()
  if (ripple && rippleMat) {
    const w = clamp01((t - 0.16) / 0.4)
    const s = 1 + easeOut(w) * 2.2
    ripple.scale.set(s, s, s)
    rippleMat.opacity = w > 0 ? 0.5 * (1 - w) : 0
  }

  // Beat 3 (1.2–4s): motes rise.
  if (points && pointsMat && particleSeeds) {
    pointsMat.opacity = windowEnv(t, 0.24, 0.86) * 0.85
    const pos = points.geometry.getAttribute('position') as THREE.BufferAttribute
    const stage = useEditorStore.getState().stage
    const baseY = stage.position[1]
    for (let i = 0; i < PARTICLES; i++) {
      let y = pos.getY(i) + particleSeeds[i * 2] * delta
      if (y > baseY + 1.6) y = baseY
      pos.setY(i, y)
    }
    pos.needsUpdate = true
  }

  // Beat 4 (1.8–4.5s): title drifts up and fades.
  if (title && titleMat) {
    titleMat.opacity = windowEnv(t, 0.36, 0.9, 0.3)
    title.position.y += delta * 0.015
  }

  // Beat 5: hand off — drop the one-shot objects, keep the dome.
  if (t >= 1) {
    running = false
    disposeEntryObjects()
  }
}

function disposeMesh(mesh: THREE.Mesh | THREE.Points | null): void {
  if (!mesh) return
  mesh.removeFromParent()
  mesh.geometry.dispose()
  const m = mesh.material as THREE.Material
  if ('map' in m) (m as THREE.MeshBasicMaterial).map?.dispose()
  m.dispose()
}

/** Removes the one-shot entry objects (ripple, motes, title) — not the dome. */
function disposeEntryObjects(): void {
  disposeMesh(ripple)
  ripple = null
  rippleMat = null
  disposeMesh(points)
  points = null
  pointsMat = null
  particleSeeds = null
  disposeMesh(title)
  title = null
  titleMat = null
  releaseAccent()
}

/** Full teardown on session end — room returns to passthrough instantly. */
export function disposeEntrySequence(): void {
  running = false
  dimBase = 0
  dimOffset = 0
  dimTarget = 0
  dimLevel = 0
  disposeEntryObjects()
  disposeMesh(lockRipple)
  lockRipple = null
  lockRippleMat = null
  disposeMesh(dome)
  dome = null
  domeMat = null
}
