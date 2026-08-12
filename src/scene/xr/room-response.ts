/**
 * Room response — the set hears you, and the set thinks.
 *
 * The stage ring is the system's voice. While you hold to talk it warms and
 * breathes with your actual level; while the crew works, a bright arc travels
 * its circumference; when the work lands it settles back to neutral. This is
 * what replaces the level bars and the pulsing dot that used to live on a card
 * under your hand — a room-scale indicator instead of a 3mm one.
 *
 * **This module is the single owner of the stage marker's tint.** The entry
 * cinematic used to write that material directly; it now asks for an accent
 * through `setRoomAccent` instead. Two writers on one material is how a ring
 * gets stuck mint after a strike.
 *
 * Cost: two extra draw calls (ripple + arc), both hidden unless their state is
 * active, geometry and textures built once, no per-frame allocation.
 *
 * This module and `entry-sequence` import each other — the entry beat asks for
 * a ring accent, the room's breathing nudges the entry dome's dim. Both calls
 * happen inside update functions rather than at module scope, so the cycle
 * resolves through hoisted function declarations and rollup bundles it without
 * complaint. Keep it that way: no top-level work that reaches across.
 */
import * as THREE from 'three'
import { useEditorStore } from '../../store'
import { setEditorLayer, tagSceneInfrastructure } from '../infrastructure'
import { setRoomDimOffset } from './entry-sequence'
import { makeCanvasTexture, XR_UI } from './xr-ui-chrome'

export type RoomState = 'idle' | 'listening' | 'working'

/** The stage marker's resting look, matched to createStageMarker. */
const NEUTRAL_COLOR = 0x888888
const NEUTRAL_OPACITY = 0.18

const LISTEN_BASE_OPACITY = 0.3
const LISTEN_LEVEL_GAIN = 0.35
const LISTEN_MAX_OPACITY = 0.55
const WORK_OPACITY = 0.32

/** Damping rates — the ring arrives and stops. Settling is slower than lighting up. */
const TINT_DAMP_UP = 8
const TINT_DAMP_DOWN = 4
/** Mic level: fast attack, slow release, same doctrine as the old level bars. */
const LEVEL_ATTACK = 0.6
const LEVEL_RELEASE = 0.12

const RIPPLE_PERIOD_MS = 1600
const RIPPLE_MAX_SCALE = 2.3
const ARC_REV_PER_SEC = 0.6
const TEX = 256

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const easeOut = (t: number) => 1 - (1 - t) ** 3

// ---- module state ----

let markerMat: THREE.MeshBasicMaterial | null = null

let ripple: THREE.Mesh | null = null
let rippleMat: THREE.MeshBasicMaterial | null = null
let arc: THREE.Mesh | null = null
let arcMat: THREE.MeshBasicMaterial | null = null

let state: RoomState = 'idle'
let level = 0
let smoothedLevel = 0

/** One-shot accent (the entry beat, a proposing agent's colour). */
let accentColor: string | null = null
let accentWeight = 0

/** How settled the director is, 0..1 — drives the room's own breathing. */
let stillness = 1
let smoothedStillness = 1
/** How far stillness may deepen the ambient dim beyond its resting level. */
const STILLNESS_DIM_RANGE = 0.08
const STILLNESS_DAMP = 1.5

let tintOpacity = NEUTRAL_OPACITY
const currentColor = new THREE.Color(NEUTRAL_COLOR)
const wantColor = new THREE.Color(NEUTRAL_COLOR)
const accentRgb = new THREE.Color()

/** Expanding rim ring — "the room is listening", drawn top-down. */
function makeRippleTexture(): THREE.CanvasTexture {
  return makeCanvasTexture(TEX, TEX, (ctx, w, h) => {
    const r = w / 2
    const g = ctx.createRadialGradient(r, h / 2, 0, r, h / 2, r)
    g.addColorStop(0, 'rgba(255,255,255,0)')
    g.addColorStop(0.8, 'rgba(255,255,255,0)')
    g.addColorStop(0.93, 'rgba(255,255,255,0.9)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  })
}

/**
 * A tapered comet on the rim — painted top-down so it can simply be spun about
 * its own axis, which is cheaper and smoother than rebuilding arc geometry.
 */
function makeArcTexture(): THREE.CanvasTexture {
  return makeCanvasTexture(TEX, TEX, (ctx, w, h) => {
    const cx = w / 2
    const cy = h / 2
    const radius = w * 0.44
    const steps = 48
    const sweep = Math.PI * 0.55
    ctx.lineCap = 'round'
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1)
      // Bright at the head, gone at the tail.
      const a = easeOut(t) * 0.95
      ctx.strokeStyle = `rgba(255,255,255,${a.toFixed(3)})`
      ctx.lineWidth = w * (0.012 + 0.016 * t)
      ctx.beginPath()
      ctx.arc(cx, cy, radius, -sweep * (1 - t), -sweep * (1 - t) + sweep / steps + 0.01)
      ctx.stroke()
    }
  })
}

function flatQuad(texture: THREE.CanvasTexture): {
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
  mesh.renderOrder = 5
  mesh.visible = false
  return { mesh, material }
}

/** Bind the stage marker whose tint this module now owns. */
export function initRoomResponse(scene: THREE.Scene, stageMarker: THREE.Group): void {
  disposeRoomResponse()

  markerMat =
    ((stageMarker.children[0] as THREE.Mesh | undefined)?.material as
      | THREE.MeshBasicMaterial
      | undefined) ?? null

  const r = flatQuad(makeRippleTexture())
  ripple = r.mesh
  rippleMat = r.material
  const a = flatQuad(makeArcTexture())
  arc = a.mesh
  arcMat = a.material

  for (const mesh of [ripple, arc]) {
    tagSceneInfrastructure(mesh)
    setEditorLayer(mesh)
    scene.add(mesh)
  }
}

export function setRoomState(next: RoomState): void {
  state = next
  if (next !== 'listening') level = 0
}

export function getRoomState(): RoomState {
  return state
}

/** Live mic RMS while listening — the ring brightens with your voice. */
export function setRoomLevel(rms: number): void {
  level = clamp01(rms)
}

/**
 * A colour the room takes on regardless of state, at `weight` 0..1 — used by
 * the entry cinematic and by a proposing agent identifying itself. Pass null
 * to release it.
 */
export function setRoomAccent(color: string | null, weight = 1): void {
  accentColor = color
  accentWeight = color ? clamp01(weight) : 0
}

/**
 * How settled the director is (0..1). A director who has stopped moving gets a
 * slightly deeper room; one crossing the floor gets it back. It is a few
 * percent of dome opacity — you should feel it and never catch it happening.
 */
export function setRoomStillness(next: number): void {
  stillness = clamp01(next)
}

export function updateRoomResponse(nowMs: number, delta: number): void {
  smoothedLevel +=
    (level - smoothedLevel) * (level > smoothedLevel ? LEVEL_ATTACK : LEVEL_RELEASE)

  // Room breathing. Slow on purpose — the set should feel like it settles with
  // you, not like it is reacting to you.
  smoothedStillness += (stillness - smoothedStillness) * Math.min(1, delta * STILLNESS_DAMP)
  setRoomDimOffset(smoothedStillness * STILLNESS_DIM_RANGE)

  // --- the ring's own tint ---
  let wantOpacity = NEUTRAL_OPACITY
  if (state === 'listening') {
    wantColor.set(XR_UI.sunDeep)
    wantOpacity = Math.min(
      LISTEN_MAX_OPACITY,
      LISTEN_BASE_OPACITY + smoothedLevel * LISTEN_LEVEL_GAIN
    )
  } else if (state === 'working') {
    wantColor.set(XR_UI.blueDeep)
    wantOpacity = WORK_OPACITY
  } else {
    wantColor.set(NEUTRAL_COLOR)
  }

  if (accentColor && accentWeight > 0) {
    accentRgb.set(accentColor)
    wantColor.lerp(accentRgb, accentWeight)
    wantOpacity = Math.max(wantOpacity, NEUTRAL_OPACITY + 0.32 * accentWeight)
  }

  const rising = wantOpacity > tintOpacity
  const k = Math.min(1, delta * (rising ? TINT_DAMP_UP : TINT_DAMP_DOWN))
  tintOpacity += (wantOpacity - tintOpacity) * k
  currentColor.lerp(wantColor, k)

  if (markerMat) {
    markerMat.color.copy(currentColor)
    markerMat.opacity = tintOpacity
  }

  // --- ripple + arc ---
  const stage = useEditorStore.getState().stage
  const [sx, sy, sz] = stage.position
  const y = sy + 0.004
  const span = stage.radius * 2

  if (ripple && rippleMat) {
    const on = state === 'listening'
    ripple.visible = on
    if (on) {
      const t = ((nowMs % RIPPLE_PERIOD_MS) / RIPPLE_PERIOD_MS)
      const s = span * (1 + easeOut(t) * (RIPPLE_MAX_SCALE - 1))
      ripple.position.set(sx, y, sz)
      ripple.scale.set(s, s, 1)
      rippleMat.color.copy(currentColor)
      // Louder voice, brighter ripple — but it always fades as it travels out.
      rippleMat.opacity = (0.14 + smoothedLevel * 0.28) * (1 - t)
    }
  }

  if (arc && arcMat) {
    const on = state === 'working'
    arc.visible = on
    if (on) {
      arc.position.set(sx, y, sz)
      arc.scale.set(span * 1.06, span * 1.06, 1)
      // Spin about the quad's own normal (it lies flat, so this is world Y).
      arc.rotation.z = -(nowMs / 1000) * ARC_REV_PER_SEC * Math.PI * 2
      arcMat.color.copy(currentColor)
      arcMat.opacity = 0.55
    }
  }
}

function disposeMesh(mesh: THREE.Mesh | null): void {
  if (!mesh) return
  mesh.removeFromParent()
  mesh.geometry.dispose()
  const m = mesh.material as THREE.MeshBasicMaterial
  m.map?.dispose()
  m.dispose()
}

export function disposeRoomResponse(): void {
  // Hand the marker back the way we found it.
  if (markerMat) {
    markerMat.color.set(NEUTRAL_COLOR)
    markerMat.opacity = NEUTRAL_OPACITY
  }
  disposeMesh(ripple)
  disposeMesh(arc)
  ripple = null
  rippleMat = null
  arc = null
  arcMat = null
  markerMat = null
  state = 'idle'
  level = 0
  smoothedLevel = 0
  accentColor = null
  accentWeight = 0
  stillness = 1
  smoothedStillness = 1
  tintOpacity = NEUTRAL_OPACITY
  currentColor.set(NEUTRAL_COLOR)
}
