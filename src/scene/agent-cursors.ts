/**
 * Renders the AI crew as Figma-style multiplayer cursors in the 3D scene.
 *
 * One cursor per agent: a tip-down cone that hovers over whatever the agent is
 * touching, plus a billboarded name label. Cursors ride render layer 1 and are
 * tagged scene-infrastructure, so they are:
 *   - invisible in the viewfinder PiP and export (virtCamera is locked to layer
 *     0 in bootstrap.ts), yet visible in the main viewport (userCamera enables
 *     both layers),
 *   - skipped by object picking (setup-picking.ts) and scene pruning
 *     (bootstrap.ts).
 *
 * The scene owns motion only: it reads the presence store (written by the agent
 * runtime) and eases each cursor toward its target over CURSOR_FLIGHT_MS — the
 * same constant the runtime waits before committing a change, so the cursor is
 * on target exactly when the scene updates.
 */
import * as THREE from 'three'
import {
  presenceStore,
  AGENT_META,
  AGENT_ORDER,
  CURSOR_FLIGHT_MS,
  type CursorPhase,
} from '../director/presence'
import { getEaseFn } from '../easing'
import { tagSceneInfrastructure } from './infrastructure'

const HOVER_HEIGHT = 1.15 // how far above the target the cursor floats
const flightEase = getEaseFn('easeOut')

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
}

function makeLabel(name: string, color: string): {
  sprite: THREE.Sprite
  material: THREE.SpriteMaterial
} {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  const r = 14
  const w = canvas.width
  const h = canvas.height
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(r, 0)
  ctx.arcTo(w, 0, w, h, r)
  ctx.arcTo(w, h, 0, h, r)
  ctx.arcTo(0, h, 0, 0, r)
  ctx.arcTo(0, 0, w, 0, r)
  ctx.closePath()
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

function buildCursor(agent: string, seed: number): Cursor {
  const { color, station } = AGENT_META[agent]
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

  group.renderOrder = 999
  group.traverse((o) => o.layers.set(1))
  tagSceneInfrastructure(group)
  group.visible = false

  return {
    group,
    coneMat,
    labelMat,
    base: new THREE.Vector3(...station),
    from: new THREE.Vector3(...station),
    moveStartedAt: 0,
    seed,
    opacity: 0,
  }
}

export interface AgentCursors {
  update(now: number): void
  dispose(): void
}

export function createAgentCursors(scene: THREE.Scene): AgentCursors {
  const cursors = new Map<string, Cursor>()
  AGENT_ORDER.forEach((agent, i) => {
    const cursor = buildCursor(agent, i * 1.7)
    cursors.set(agent, cursor)
    scene.add(cursor.group)
  })

  const pulse = (phase: CursorPhase | undefined, now: number): number => {
    if (phase === 'working') return 1 + 0.09 * Math.sin(now / 70)
    if (phase === 'settling') return 1.04
    return 1
  }

  const update = (now: number) => {
    const agents = presenceStore.getState().agents
    for (const [agent, cursor] of cursors) {
      const p = agents[agent]
      const wantOpacity = p?.active ? 1 : 0
      cursor.opacity += (wantOpacity - cursor.opacity) * 0.16

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
        const elapsed = p.moveStartedAt > 0 ? now - p.moveStartedAt : CURSOR_FLIGHT_MS
        const alpha = flightEase(Math.min(1, Math.max(0, elapsed / CURSOR_FLIGHT_MS)))
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
    }
  }

  const dispose = () => {
    for (const cursor of cursors.values()) {
      scene.remove(cursor.group)
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
