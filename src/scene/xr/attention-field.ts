/**
 * Attention field — the object answers, not a card.
 *
 * When you aim at something, or the crew is about to change it, the object
 * itself is lit: a soft pool on the stage floor beneath it and a quiet ring at
 * its waist. The set acknowledges by drawing light to the thing you mean,
 * instead of printing its name on a slate under your hand.
 *
 * One rig, reused. The pool and ring are built once and re-parked on whichever
 * object is currently attended, so the cost is two draw calls no matter how
 * many objects are on stage — nothing is cloned per target and nothing is
 * allocated on the frame path.
 *
 * Both meshes live on EDITOR_LAYER: the director sees them, the film never does.
 */
import * as THREE from 'three'
import { useEditorStore } from '../../store'
import { setEditorLayer, tagSceneInfrastructure } from '../infrastructure'
import { makeCanvasTexture, XR_UI } from './xr-ui-chrome'

export type AttentionTone = 'aimed' | 'addressed' | 'missed' | 'landed'

interface ToneSpec {
  color: string
  opacity: number
  /** Multiplier on the target's bounding radius. */
  spread: number
  /** Breathing depth (0 = steady) and rate in Hz. */
  breathe: number
  breatheHz: number
}

/**
 * Normal blending, not additive: additive light pools vanish against a bright
 * real floor in passthrough, and the whole point is that this reads in any room.
 */
const TONES: Record<AttentionTone, ToneSpec> = {
  aimed: { color: XR_UI.mint, opacity: 0.22, spread: 1.35, breathe: 0.06, breatheHz: 0.5 },
  addressed: { color: XR_UI.mintDeep, opacity: 0.45, spread: 1.55, breathe: 0.1, breatheHz: 0.9 },
  missed: { color: XR_UI.pinkDeep, opacity: 0.5, spread: 1.35, breathe: 0, breatheHz: 0 },
  landed: { color: XR_UI.sun, opacity: 0.35, spread: 1.45, breathe: 0, breatheHz: 0 },
}

/** One-shot tones play an envelope and hand back to the resting tone. */
const PULSE_MS: Partial<Record<AttentionTone, number>> = {
  missed: 420,
  landed: 600,
}

/** Damping rates — arrive and stop (the settle register, no overshoot). */
const OPACITY_DAMP = 9
const RADIUS_DAMP = 7
/** `landed` is a release, so it earns a little overshoot on the way back. */
const LANDED_OVERSHOOT = 1.04

const POOL_TEX = 256
const RING_TEX = 256
/** Sits just above the stage ring (+0.005) so the two never z-fight. */
const FLOOR_LIFT = 0.006
/** Floor for the attended radius — a tiny object still gets a readable pool. */
const MIN_RADIUS = 0.08

const easeOut = (t: number) => 1 - (1 - t) ** 3
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

// ---- module state (one field per session, same shape as aim-picker/entry-sequence) ----

let pool: THREE.Mesh | null = null
let poolMat: THREE.MeshBasicMaterial | null = null
let ring: THREE.Mesh | null = null
let ringMat: THREE.MeshBasicMaterial | null = null
let group: THREE.Group | null = null

/** The object we're attending, and its cached live mesh + size. */
let targetId: string | null = null
let targetMesh: THREE.Object3D | null = null
let targetRadius = MIN_RADIUS
let targetHeight = 0
/** World-scale signature of the cached bounds — recompute when it moves. */
let boundsScaleSig = 0

let restTone: AttentionTone = 'aimed'
let activeTone: AttentionTone = 'aimed'
let pulseUntil = 0
let pulseFrom = 0

let opacity = 0
let radius = MIN_RADIUS

const scratchBox = new THREE.Box3()
const scratchSize = new THREE.Vector3()
const scratchCenter = new THREE.Vector3()
const scratchWorld = new THREE.Vector3()
const toneColor = new THREE.Color()

/** Soft disc: brightest at the middle, gone by the rim. */
function makePoolTexture(): THREE.CanvasTexture {
  return makeCanvasTexture(POOL_TEX, POOL_TEX, (ctx, w, h) => {
    const r = w / 2
    const g = ctx.createRadialGradient(r, h / 2, 0, r, h / 2, r)
    g.addColorStop(0, 'rgba(255,255,255,0.95)')
    g.addColorStop(0.45, 'rgba(255,255,255,0.55)')
    g.addColorStop(0.78, 'rgba(255,255,255,0.16)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  })
}

/** A band near the rim — reads as a ring even on an object that floats. */
function makeRingTexture(): THREE.CanvasTexture {
  return makeCanvasTexture(RING_TEX, RING_TEX, (ctx, w, h) => {
    const r = w / 2
    const g = ctx.createRadialGradient(r, h / 2, 0, r, h / 2, r)
    g.addColorStop(0, 'rgba(255,255,255,0)')
    g.addColorStop(0.72, 'rgba(255,255,255,0)')
    g.addColorStop(0.85, 'rgba(255,255,255,0.85)')
    g.addColorStop(0.96, 'rgba(255,255,255,0.2)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  })
}

function flatQuad(texture: THREE.CanvasTexture, renderOrder: number): {
  mesh: THREE.Mesh
  material: THREE.MeshBasicMaterial
} {
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material)
  mesh.rotation.x = -Math.PI / 2
  mesh.renderOrder = renderOrder
  mesh.visible = false
  return { mesh, material }
}

/** Build the rig once at bootstrap. Safe to call again — it rebuilds cleanly. */
export function initAttentionField(scene: THREE.Scene): void {
  disposeAttentionField()

  group = new THREE.Group()
  const p = flatQuad(makePoolTexture(), 6)
  pool = p.mesh
  poolMat = p.material
  const r = flatQuad(makeRingTexture(), 6)
  ring = r.mesh
  ringMat = r.material
  group.add(pool, ring)

  tagSceneInfrastructure(group)
  setEditorLayer(group)
  scene.add(group)
}

/**
 * Attend to an object (or nothing). `tone` becomes the resting tone — the one
 * the field returns to after any one-shot pulse finishes.
 */
export function attendTo(objectId: string | null, tone: AttentionTone = 'aimed'): void {
  restTone = tone
  if (objectId === targetId) {
    if (pulseUntil === 0) activeTone = tone
    return
  }
  targetId = objectId
  targetMesh = null
  boundsScaleSig = 0
  pulseUntil = 0
  activeTone = tone
  if (!objectId) return
  resolveTargetMesh()
}

/**
 * A one-shot beat on an object — a miss, or a change landing. Plays its
 * envelope, then hands back to the resting tone.
 */
export function pulseAttention(objectId: string, tone: AttentionTone): void {
  const ms = PULSE_MS[tone]
  if (!ms) {
    attendTo(objectId, tone)
    return
  }
  if (objectId !== targetId) {
    targetId = objectId
    targetMesh = null
    boundsScaleSig = 0
    resolveTargetMesh()
  }
  activeTone = tone
  pulseFrom = performance.now()
  pulseUntil = pulseFrom + ms
}

export function clearAttention(): void {
  attendTo(null, 'aimed')
}

function resolveTargetMesh(): void {
  if (!targetId) return
  const obj = useEditorStore.getState().objects.find((o) => o.id === targetId)
  targetMesh = obj?.mesh ?? null
  if (targetMesh) measureTarget()
}

/** Bounds are measured on target change and on a real scale change — never per frame. */
function measureTarget(): void {
  if (!targetMesh) return
  scratchBox.setFromObject(targetMesh)
  if (scratchBox.isEmpty()) {
    targetRadius = MIN_RADIUS
    targetHeight = 0
    return
  }
  scratchBox.getSize(scratchSize)
  scratchBox.getCenter(scratchCenter)
  targetRadius = Math.max(MIN_RADIUS, Math.max(scratchSize.x, scratchSize.z) / 2)
  targetHeight = scratchCenter.y
  boundsScaleSig = targetMesh.scale.lengthSq()
}

/** Per-frame tick from the XR branch of the animate loop. */
export function updateAttentionField(nowMs: number, delta: number): void {
  if (!group || !pool || !poolMat || !ring || !ringMat) return

  // A removed object is detached from the scene graph — stop attending it.
  if (targetMesh && !targetMesh.parent) {
    targetMesh = null
    targetId = null
  }
  if (targetId && !targetMesh) resolveTargetMesh()

  const wanted = targetMesh ? 1 : 0
  if (!targetMesh && opacity < 0.002) {
    if (group.visible) group.visible = false
    opacity = 0
    return
  }
  group.visible = true

  // One-shot envelope, then hand back to the resting tone.
  let envelope = 1
  if (pulseUntil > 0) {
    const t = clamp01((nowMs - pulseFrom) / (pulseUntil - pulseFrom))
    // Fast in, eased out — a beat, not a blink.
    envelope = t < 0.25 ? t / 0.25 : easeOut(1 - (t - 0.25) / 0.75)
    if (t >= 1) {
      pulseUntil = 0
      activeTone = restTone
      envelope = 1
    }
  }

  const spec = TONES[activeTone]

  if (targetMesh) {
    if (Math.abs(targetMesh.scale.lengthSq() - boundsScaleSig) > 1e-4) measureTarget()
    targetMesh.getWorldPosition(scratchWorld)
  }

  const breathe =
    spec.breathe > 0 ? 1 + Math.sin((nowMs / 1000) * spec.breatheHz * Math.PI * 2) * spec.breathe : 1

  const wantRadius = targetRadius * spec.spread * breathe
  const wantOpacity = spec.opacity * envelope * wanted

  opacity += (wantOpacity - opacity) * Math.min(1, delta * OPACITY_DAMP)
  // `landed` is the release of a held action, so it gets to overshoot slightly.
  const overshoot = activeTone === 'landed' && pulseUntil > 0 ? LANDED_OVERSHOOT : 1
  radius += (wantRadius * overshoot - radius) * Math.min(1, delta * RADIUS_DAMP)

  toneColor.set(spec.color)
  poolMat.color.copy(toneColor)
  ringMat.color.copy(toneColor)
  poolMat.opacity = opacity
  ringMat.opacity = opacity * 0.8

  const stageY = useEditorStore.getState().stage.position[1]
  const d = radius * 2

  pool.position.set(scratchWorld.x, stageY + FLOOR_LIFT, scratchWorld.z)
  pool.scale.set(d * 1.6, d * 1.6, 1)

  // The waist ring rides the object itself, so a floating hero still reads.
  ring.position.set(scratchWorld.x, scratchWorld.y + targetHeight * 0.15, scratchWorld.z)
  ring.scale.set(d * 1.25, d * 1.25, 1)
}

function disposeMesh(mesh: THREE.Mesh | null): void {
  if (!mesh) return
  mesh.removeFromParent()
  mesh.geometry.dispose()
  const m = mesh.material as THREE.MeshBasicMaterial
  m.map?.dispose()
  m.dispose()
}

export function disposeAttentionField(): void {
  disposeMesh(pool)
  disposeMesh(ring)
  pool = null
  poolMat = null
  ring = null
  ringMat = null
  group?.removeFromParent()
  group = null
  targetId = null
  targetMesh = null
  targetRadius = MIN_RADIUS
  targetHeight = 0
  boundsScaleSig = 0
  restTone = 'aimed'
  activeTone = 'aimed'
  pulseUntil = 0
  opacity = 0
  radius = MIN_RADIUS
}
