/**
 * Renders the AI crew as Figma-style multiplayer cursors in the 3D scene.
 *
 * One cursor per agent: a tip-down cone that hovers over whatever the agent is
 * touching, a billboarded name label, plus a small note sprite ("tracing
 * bounce 12/25") under it. While an agent traces an animation path, the cursor
 * leaves a fading agent-tinted trail. Cursors, notes and trails ride render
 * layer 1 and are tagged scene-infrastructure, so they are:
 *   - invisible in the viewfinder PiP and export (virtCamera is locked to layer
 *     0 in bootstrap.ts), yet visible in the main viewport (userCamera enables
 *     both layers),
 *   - skipped by object picking (setup-picking.ts) and scene pruning
 *     (bootstrap.ts).
 *
 * The scene owns motion only: it reads the presence store (written by the agent
 * runtime) and eases each cursor toward its target over the move's duration —
 * the same clock the runtime waits before committing a change, so the cursor is
 * on target exactly when the scene updates.
 */
import * as THREE from 'three'
import {
  presenceStore,
  AGENT_ORDER,
  agentMetaFor,
  type CursorPhase,
} from '../director/presence'
import { getEaseFn } from '../easing'
import { tagSceneInfrastructure } from './infrastructure'

const HOVER_HEIGHT = 1.15 // how far above the target the cursor floats
const CONE_TIP_DROP = 0.23 // cone half-height; the drawing tip is this far below the group
const flightEase = getEaseFn('easeOut')

const MAX_TRAIL_POINTS = 256 // preallocated; a preset track is well under this
const TRAIL_MIN_STEP = 0.04 // min tip travel before a new trail vertex is laid
const TRAIL_FADE_MS = 1500 // fade-out after tracing ends
const TRAIL_RISE_MS = 200 // fade-in as tracing begins

const _tip = new THREE.Vector3()

interface Cursor {
  group: THREE.Group
  coneMat: THREE.MeshBasicMaterial
  labelMat: THREE.SpriteMaterial
  /** Eased base point (the target itself, before hover offset). */
  base: THREE.Vector3
  /** Where the current flight started from. */
  from: THREE.Vector3
  /** Mirrors presence.moveStartedAt so we know when to reseat `from`. */
  moveStartedAt: number
  /** Bob phase offset so cursors don't pulse in lockstep. */
  seed: number
  /** Fade level, eased toward 1 (active) / 0 (idle). */
  opacity: number
  /** World-space path the cursor drew while tracing. */
  trail: THREE.Line
  trailMat: THREE.LineBasicMaterial
  trailPositions: Float32Array
  trailCount: number
  trailOpacity: number
  lastTrailPoint: THREE.Vector3 | null
  wasTracing: boolean
  /** Note sprite under the label + its backing canvas (redrawn on text change). */
  noteMat: THREE.SpriteMaterial
  noteCanvas: HTMLCanvasElement
  noteText: string
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function makeLabel(name: string, color: string): {
  sprite: THREE.Sprite
  material: THREE.SpriteMaterial
} {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  const w = canvas.width
  const h = canvas.height
  ctx.fillStyle = color
  roundRectPath(ctx, 0, 0, w, h, 14)
  ctx.fill()
  ctx.fillStyle = '#000000'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const label = name.toUpperCase()
  // Shrink to fit long crew names (e.g. ASSETANIMATOR) inside the pill.
  let fontPx = 34
  do {
    ctx.font = `bold ${fontPx}px "Arial Black", sans-serif`
    fontPx -= 2
  } while (fontPx > 14 && ctx.measureText(label).width > w - 24)
  ctx.fillText(label, w / 2, h / 2 + 2)

  const texture = new THREE.CanvasTexture(canvas)
  texture.anisotropy = 4
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(1.1, 0.275, 1)
  return { sprite, material }
}

function makeNote(): {
  sprite: THREE.Sprite
  material: THREE.SpriteMaterial
  canvas: HTMLCanvasElement
} {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 40
  const texture = new THREE.CanvasTexture(canvas)
  texture.anisotropy = 4
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, opacity: 0 })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(0.95, 0.148, 1)
  sprite.position.set(0, 0.31, 0) // just under the name label (label sits at y=0.5)
  return { sprite, material, canvas }
}

/** Redraw the note pill only when its text changes (canvas work is not free). */
function drawNote(cursor: Cursor, text: string): void {
  if (cursor.noteText === text) return
  cursor.noteText = text
  const canvas = cursor.noteCanvas
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (text) {
    ctx.font = 'bold 22px "Arial", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const pill = Math.min(canvas.width - 4, ctx.measureText(text).width + 26)
    ctx.fillStyle = 'rgba(0,0,0,0.78)'
    roundRectPath(ctx, (canvas.width - pill) / 2, 4, pill, 32, 9)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.fillText(text, canvas.width / 2, canvas.height / 2)
  }
  cursor.noteMat.map!.needsUpdate = true
}

function buildCursor(agent: string, seed: number): Cursor {
  const { color, station } = agentMetaFor(agent)
  const group = new THREE.Group()

  const coneMat = new THREE.MeshBasicMaterial({ color, transparent: true })
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.46, 24), coneMat)
  cone.rotation.x = Math.PI // tip points down, at the target below
  cone.castShadow = false
  cone.receiveShadow = false
  group.add(cone)

  const { sprite, material: labelMat } = makeLabel(agent, color)
  sprite.position.set(0, 0.5, 0)
  group.add(sprite)

  const { sprite: noteSprite, material: noteMat, canvas: noteCanvas } = makeNote()
  group.add(noteSprite)

  group.renderOrder = 999
  group.traverse((o) => o.layers.set(1))
  tagSceneInfrastructure(group)
  group.visible = false

  // Trail: a world-space polyline the cursor draws while tracing. Kept OUT of
  // the group (which moves with the cursor) so its vertices stay in world space.
  const trailPositions = new Float32Array(MAX_TRAIL_POINTS * 3)
  const trailGeom = new THREE.BufferGeometry()
  trailGeom.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3))
  trailGeom.setDrawRange(0, 0)
  const trailMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0, depthTest: false })
  const trail = new THREE.Line(trailGeom, trailMat)
  trail.renderOrder = 998
  trail.layers.set(1)
  tagSceneInfrastructure(trail)
  trail.visible = false

  return {
    group,
    coneMat,
    labelMat,
    base: new THREE.Vector3(...station),
    from: new THREE.Vector3(...station),
    moveStartedAt: 0,
    seed,
    opacity: 0,
    trail,
    trailMat,
    trailPositions,
    trailCount: 0,
    trailOpacity: 0,
    lastTrailPoint: null,
    wasTracing: false,
    noteMat,
    noteCanvas,
    noteText: '',
  }
}

export interface AgentCursors {
  update(now: number): void
  dispose(): void
}

export function createAgentCursors(scene: THREE.Scene): AgentCursors {
  const cursors = new Map<string, Cursor>()
  let cursorSeed = 0

  function ensureCursor(agent: string): Cursor {
    let cursor = cursors.get(agent)
    if (cursor) return cursor
    cursor = buildCursor(agent, cursorSeed++)
    cursors.set(agent, cursor)
    scene.add(cursor.group)
    scene.add(cursor.trail)
    return cursor
  }

  AGENT_ORDER.forEach((agent) => {
    ensureCursor(agent)
  })

  let prevNow = performance.now()

  const pulse = (phase: CursorPhase | undefined, now: number): number => {
    if (phase === 'working' || phase === 'tracing') return 1 + 0.09 * Math.sin(now / 70)
    if (phase === 'settling') return 1.04
    return 1
  }

  const pushTrailPoint = (cursor: Cursor, pt: THREE.Vector3) => {
    if (cursor.trailCount >= MAX_TRAIL_POINTS) return
    const i = cursor.trailCount * 3
    cursor.trailPositions[i] = pt.x
    cursor.trailPositions[i + 1] = pt.y
    cursor.trailPositions[i + 2] = pt.z
    cursor.trailCount += 1
    cursor.trail.geometry.setDrawRange(0, cursor.trailCount)
    cursor.trail.geometry.attributes.position.needsUpdate = true
    cursor.trail.geometry.computeBoundingSphere()
    cursor.lastTrailPoint = (cursor.lastTrailPoint ?? new THREE.Vector3()).copy(pt)
  }

  const resetTrail = (cursor: Cursor) => {
    cursor.trailCount = 0
    cursor.lastTrailPoint = null
    cursor.trailOpacity = 0
    cursor.trail.geometry.setDrawRange(0, 0)
  }

  const updateTrail = (cursor: Cursor, tracing: boolean, dt: number) => {
    if (tracing && !cursor.wasTracing) resetTrail(cursor) // fresh trace starts clean
    cursor.wasTracing = tracing

    if (tracing) {
      cursor.trailOpacity = Math.min(1, cursor.trailOpacity + dt / TRAIL_RISE_MS)
      // Sample the drawing tip (bottom of the cone), thresholded to avoid flooding.
      _tip.set(cursor.group.position.x, cursor.group.position.y - CONE_TIP_DROP, cursor.group.position.z)
      if (!cursor.lastTrailPoint || cursor.lastTrailPoint.distanceTo(_tip) > TRAIL_MIN_STEP) {
        pushTrailPoint(cursor, _tip)
      }
    } else if (cursor.trailCount > 0) {
      cursor.trailOpacity -= dt / TRAIL_FADE_MS
      if (cursor.trailOpacity <= 0) resetTrail(cursor)
    }

    cursor.trailMat.opacity = cursor.trailOpacity
    cursor.trail.visible = cursor.trailCount > 1 && cursor.trailOpacity > 0.001
  }

  const update = (now: number) => {
    const dt = Math.max(0, now - prevNow)
    prevNow = now
    const agents = presenceStore.getState().agents
    for (const agent of Object.keys(agents)) ensureCursor(agent)
    for (const [agent, cursor] of cursors) {
      const p = agents[agent]
      const wantOpacity = p?.active ? 1 : 0
      cursor.opacity += (wantOpacity - cursor.opacity) * 0.16

      const tracing = p?.phase === 'tracing' && cursor.opacity > 0.01
      updateTrail(cursor, tracing, dt)

      if (wantOpacity === 0 && cursor.opacity < 0.01) {
        cursor.group.visible = false
        continue
      }
      cursor.group.visible = true

      if (p) {
        // A changed clock means a new flight: ease from wherever we are now.
        if (p.moveStartedAt !== cursor.moveStartedAt) {
          cursor.from.copy(cursor.base)
          cursor.moveStartedAt = p.moveStartedAt
        }
        const durationMs = p.moveDurationMs > 0 ? p.moveDurationMs : 1
        const elapsed = p.moveStartedAt > 0 ? now - p.moveStartedAt : durationMs
        const alpha = flightEase(Math.min(1, Math.max(0, elapsed / durationMs)))
        cursor.base.set(
          cursor.from.x + (p.target[0] - cursor.from.x) * alpha,
          cursor.from.y + (p.target[1] - cursor.from.y) * alpha,
          cursor.from.z + (p.target[2] - cursor.from.z) * alpha
        )
      }

      const bob = Math.sin(now / 320 + cursor.seed) * 0.07
      cursor.group.position.set(
        cursor.base.x,
        cursor.base.y + HOVER_HEIGHT + bob,
        cursor.base.z
      )
      cursor.group.scale.setScalar((0.55 + 0.45 * cursor.opacity) * pulse(p?.phase, now))
      cursor.coneMat.opacity = cursor.opacity
      cursor.labelMat.opacity = cursor.opacity

      drawNote(cursor, p?.note ?? '')
      cursor.noteMat.opacity = p?.note ? cursor.opacity : 0
    }
  }

  const dispose = () => {
    for (const cursor of cursors.values()) {
      scene.remove(cursor.group)
      scene.remove(cursor.trail)
      cursor.trail.geometry.dispose()
      cursor.trailMat.dispose()
      cursor.group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose()
          ;(o.material as THREE.Material).dispose()
        } else if (o instanceof THREE.Sprite) {
          o.material.map?.dispose()
          o.material.dispose()
        }
      })
    }
    cursors.clear()
  }

  return { update, dispose }
}
