/**
 * Renders the AI crew as Figma-style multiplayer cursors in the 3D scene.
 *
 * Cursors glide to a target, then track the affected object's live position
 * while it animates — the main viewport and viewfinder show the real motion.
 */
import * as THREE from 'three'
import {
  presenceStore,
  CURSOR_AGENT_ORDER,
  agentMetaFor,
  cursorVisible,
  stationFor,
  type CursorPhase,
} from '../director/presence'
import { sampleObjectAtTime } from '../director/scene-state-sync'
import { useEditorStore } from '../store'
import { getEaseFn } from '../easing'
import { tagSceneInfrastructure, setEditorLayer } from './infrastructure'

const HOVER_HEIGHT = 1.15
const WANDER_RADIUS = 0.4
const GLANCE_INTERVAL_MS = 6000
const GLANCE_DURATION_MS = 1200
const flightEase = getEaseFn('easeOut')

interface Cursor {
  group: THREE.Group
  coneMat: THREE.MeshBasicMaterial
  labelMat: THREE.SpriteMaterial
  base: THREE.Vector3
  from: THREE.Vector3
  moveStartedAt: number
  seed: number
  opacity: number
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
  sprite.position.set(0, 0.31, 0)
  return { sprite, material, canvas }
}

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
  cone.rotation.x = Math.PI
  cone.castShadow = false
  cone.receiveShadow = false
  group.add(cone)

  const { sprite, material: labelMat } = makeLabel(agent, color)
  sprite.position.set(0, 0.5, 0)
  group.add(sprite)

  const { sprite: noteSprite, material: noteMat, canvas: noteCanvas } = makeNote()
  group.add(noteSprite)

  group.renderOrder = 999
  setEditorLayer(group)
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
    return cursor
  }

  CURSOR_AGENT_ORDER.forEach((agent) => {
    ensureCursor(agent)
  })

  const pulse = (phase: CursorPhase | undefined, now: number): number => {
    if (phase === 'intent') return 1 + 0.06 * Math.sin(now / 55)
    if (phase === 'working') return 1 + 0.09 * Math.sin(now / 70)
    if (phase === 'settling') return 1.04
    return 1
  }

  const update = (now: number) => {
    const agents = presenceStore.getState().agents
    const editor = useEditorStore.getState()
    for (const agent of Object.keys(agents)) {
      if (cursorVisible(agent)) ensureCursor(agent)
    }
    for (const [agent, cursor] of cursors) {
      if (!cursorVisible(agent)) continue
      const p = agents[agent]
      const isLinger = p?.idleMode === 'linger'
      const isVisible = p?.active && p.idleMode !== 'faded'
      const wantOpacity = isVisible ? 1 : 0
      cursor.opacity += (wantOpacity - cursor.opacity) * (isLinger ? 0.08 : 0.16)

      if (wantOpacity === 0 && cursor.opacity < 0.01) {
        cursor.group.visible = false
        continue
      }
      cursor.group.visible = true

      if (p?.followObjectId) {
        const obj = editor.objects.find((o) => o.id === p.followObjectId)
        if (obj) {
          const sampled = sampleObjectAtTime(obj, editor.currentTime)
          cursor.base.set(sampled.position[0], sampled.position[1], sampled.position[2])
        }
      } else if (isLinger) {
        const station = stationFor(agent)
        const wanderAngle = now / 4000 + cursor.seed * 2
        const wx = station[0] + Math.cos(wanderAngle) * WANDER_RADIUS
        const wz = station[2] + Math.sin(wanderAngle) * WANDER_RADIUS
        let tx = wx
        let ty = station[1]
        let tz = wz
        const glancePhase = (now + cursor.seed * 1000) % GLANCE_INTERVAL_MS
        if (p.lastTouchedObjectId && glancePhase < GLANCE_DURATION_MS) {
          const obj = editor.objects.find((o) => o.id === p.lastTouchedObjectId)
          if (obj) {
            const sampled = sampleObjectAtTime(obj, editor.currentTime)
            const alpha = glancePhase / GLANCE_DURATION_MS
            const ease = flightEase(alpha)
            tx = wx + (sampled.position[0] - wx) * ease * 0.55
            ty = station[1] + (sampled.position[1] - station[1]) * ease * 0.35
            tz = wz + (sampled.position[2] - wz) * ease * 0.55
          }
        }
        cursor.base.set(tx, ty, tz)
      } else if (p) {
        if (p.moveStartedAt !== cursor.moveStartedAt) {
          cursor.from.copy(cursor.base)
          cursor.moveStartedAt = p.moveStartedAt
        }
        const durationMs = p.moveDurationMs > 0 ? p.moveDurationMs : 1
        const elapsed = p.moveStartedAt > 0 ? now - p.moveStartedAt : durationMs
        const ease = p.phase === 'intent' ? getEaseFn('easeOut') : flightEase
        const alpha = ease(Math.min(1, Math.max(0, elapsed / durationMs)))
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
