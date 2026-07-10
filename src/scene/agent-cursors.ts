/**
 * Renders the AI crew as Figma-style multiplayer cursors in the 3D scene.
 *
 * Cursors glide to a target, then track the affected object's live position
 * while it animates — the main viewport and viewfinder show the real motion.
 *
 * Status reads explicitly: a rotating arc spinner while an agent is thinking,
 * a confirmed two-line radio bubble while it applies, and a check mark on
 * settle. Spinner motion is transform-only (sprite rotation), so canvas
 * textures are redrawn only when text changes.
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
import { drawBrutalCard, makeCanvasTexture, XR_UI } from './xr/xr-ui-chrome'
import { getCursorStatusVisibility } from './agent-cursor-status'

const HOVER_HEIGHT = 1.15
const WANDER_RADIUS = 0.4
const GLANCE_INTERVAL_MS = 6000
const GLANCE_DURATION_MS = 1200
const STATUS_SLOT_Y = 0.46
const LABEL_Y = 0.82
const flightEase = getEaseFn('easeOut')

const REDUCE_MOTION =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

const SPINNER_SPEED = 0.006 // radians per ms

interface Cursor {
  group: THREE.Group
  coneMat: THREE.MeshBasicMaterial
  coneOutlineMat: THREE.MeshBasicMaterial
  labelMat: THREE.SpriteMaterial
  base: THREE.Vector3
  from: THREE.Vector3
  moveStartedAt: number
  seed: number
  opacity: number
  noteMat: THREE.SpriteMaterial
  noteSprite: THREE.Sprite
  noteText: string
  spinnerMat: THREE.SpriteMaterial
  arcTex: THREE.CanvasTexture
  checkTex: THREE.CanvasTexture
  spinnerPhase: 'active' | 'settling' | undefined
}

function makeLabel(name: string, color: string): {
  sprite: THREE.Sprite
  material: THREE.SpriteMaterial
} {
  const label = name.toUpperCase()
  const texture = makeCanvasTexture(768, 160, (ctx, w, h) => {
    drawBrutalCard(ctx, w, h, { fill: color, shadowPx: 14, borderPx: 10 })
    ctx.fillStyle = XR_UI.ink
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    let fontPx = 64
    do {
      ctx.font = `bold ${fontPx}px "JetBrains Mono", ui-monospace, monospace`
      fontPx -= 2
    } while (fontPx > 24 && ctx.measureText(label).width > w - 72)
    ctx.fillText(label, w / 2, h / 2 - 5)
  })
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(1.3, 0.27, 1)
  return { sprite, material }
}

/** Thick open arc — rotated each frame to read as a spinner. Drawn once. */
function makeArcTexture(color: string): THREE.CanvasTexture {
  return makeCanvasTexture(160, 160, (ctx) => {
    ctx.lineCap = 'square'
    ctx.beginPath()
    ctx.strokeStyle = XR_UI.ink
    ctx.lineWidth = 30
    ctx.arc(80, 80, 54, Math.PI * 0.3, Math.PI * 1.8)
    ctx.stroke()
    ctx.beginPath()
    ctx.strokeStyle = color
    ctx.lineWidth = 18
    ctx.arc(80, 80, 54, Math.PI * 0.3, Math.PI * 1.8)
    ctx.stroke()
  })
}

/** Check mark — swapped in on settle so completion reads instantly. */
function makeCheckTexture(color: string): THREE.CanvasTexture {
  return makeCanvasTexture(160, 160, (ctx, w, h) => {
    drawBrutalCard(ctx, w, h, { fill: color, shadowPx: 10, borderPx: 10 })
    ctx.strokeStyle = XR_UI.ink
    ctx.lineWidth = 16
    ctx.lineJoin = 'miter'
    ctx.lineCap = 'square'
    ctx.beginPath()
    ctx.moveTo(38, 82)
    ctx.lineTo(68, 112)
    ctx.lineTo(124, 48)
    ctx.stroke()
  })
}

function makeNote(): {
  sprite: THREE.Sprite
  material: THREE.SpriteMaterial
} {
  const texture = makeCanvasTexture(2, 2, () => {})
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, opacity: 0 })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(0.01, 0.01, 1)
  sprite.position.set(0, STATUS_SLOT_Y, 0)
  return { sprite, material }
}

function fitLine(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  suffix = ''
): string {
  if (ctx.measureText(`${text}${suffix}`).width <= maxW) return `${text}${suffix}`
  let value = text
  while (value.length > 0 && ctx.measureText(`${value}${suffix}`).width > maxW) {
    value = value.slice(0, -1)
  }
  return `${value}${suffix}`
}

/** Wrap into at most two lines and never let a measured word clip. */
function wrapTwoLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const lines: string[] = []
  let line = ''
  let truncated = false
  for (const word of words) {
    if (!line) {
      line = word
      continue
    }
    const test = `${line} ${word}`
    if (ctx.measureText(test).width <= maxW) {
      line = test
    } else {
      if (lines.length === 1) {
        truncated = true
        break
      }
      lines.push(line)
      line = word
    }
  }
  if (line && lines.length < 2) lines.push(line)
  if (lines.length === 0) return [fitLine(ctx, words[0], maxW, '…')]
  if (truncated) {
    const last = lines.length === 1 ? 0 : 1
    lines[last] = fitLine(ctx, lines[last], maxW, '…')
  }
  return lines.map((value) =>
    fitLine(ctx, value, maxW, ctx.measureText(value).width > maxW ? '…' : '')
  )
}

function drawNote(cursor: Cursor, text: string): void {
  if (cursor.noteText === text) return
  cursor.noteText = text
  cursor.noteMat.map?.dispose()
  if (!text) {
    cursor.noteMat.map = makeCanvasTexture(2, 2, () => {})
    cursor.noteSprite.scale.set(0.01, 0.01, 1)
    cursor.noteMat.needsUpdate = true
    return
  }

  const font = 'bold 44px "JetBrains Mono", ui-monospace, monospace'
  const measureCanvas = document.createElement('canvas')
  const measureCtx = measureCanvas.getContext('2d')!
  measureCtx.font = font
  const lines = wrapTwoLines(measureCtx, text, 760)
  const lineH = 52
  const cardH = lines.length === 2 ? 184 : 136
  const cardW = Math.min(
    896,
    Math.max(420, Math.ceil(Math.max(...lines.map((line) => measureCtx.measureText(line).width)) + 72))
  )
  const texture = makeCanvasTexture(cardW, cardH, (ctx, w, h) => {
    drawBrutalCard(ctx, w, h, { fill: XR_UI.paper, shadowPx: 14, borderPx: 10 })
    ctx.fillStyle = XR_UI.ink
    ctx.font = font
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const startY = h / 2 - ((lines.length - 1) * lineH) / 2
    lines.forEach((line, index) => ctx.fillText(line, w / 2, startY + index * lineH))
  })
  cursor.noteMat.map = texture
  cursor.noteMat.needsUpdate = true
  const worldH = lines.length === 2 ? 0.28 : 0.2
  cursor.noteSprite.scale.set(worldH * (cardW / cardH), worldH, 1)
}

function buildCursor(agent: string, seed: number): Cursor {
  const { color, station } = agentMetaFor(agent)
  const group = new THREE.Group()

  const coneOutlineMat = new THREE.MeshBasicMaterial({ color: XR_UI.ink, transparent: true })
  const coneOutline = new THREE.Mesh(new THREE.ConeGeometry(0.174, 0.49, 24), coneOutlineMat)
  coneOutline.rotation.x = Math.PI
  coneOutline.castShadow = false
  coneOutline.receiveShadow = false
  group.add(coneOutline)

  const coneMat = new THREE.MeshBasicMaterial({ color, transparent: true })
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.46, 24), coneMat)
  cone.rotation.x = Math.PI
  cone.castShadow = false
  cone.receiveShadow = false
  group.add(cone)

  const { sprite, material: labelMat } = makeLabel(agent, color)
  sprite.position.set(0, LABEL_Y, 0)
  group.add(sprite)

  const { sprite: noteSprite, material: noteMat } = makeNote()
  group.add(noteSprite)

  const arcTex = makeArcTexture(color)
  const checkTex = makeCheckTexture(color)
  const spinnerMat = new THREE.SpriteMaterial({
    map: arcTex,
    transparent: true,
    depthTest: false,
    opacity: 0,
  })
  const spinner = new THREE.Sprite(spinnerMat)
  spinner.scale.set(0.3, 0.3, 1)
  // The loading affordance occupies the exact note-bubble slot.
  spinner.position.set(0, STATUS_SLOT_Y, 0)
  group.add(spinner)

  group.renderOrder = 999
  setEditorLayer(group)
  tagSceneInfrastructure(group)
  group.visible = false

  return {
    group,
    coneMat,
    coneOutlineMat,
    labelMat,
    base: new THREE.Vector3(...station),
    from: new THREE.Vector3(...station),
    moveStartedAt: 0,
    seed,
    opacity: 0,
    noteMat,
    noteSprite,
    noteText: '',
    spinnerMat,
    arcTex,
    checkTex,
    spinnerPhase: undefined,
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

      const bob = REDUCE_MOTION ? 0 : Math.sin(now / 320 + cursor.seed) * 0.05
      cursor.group.position.set(
        cursor.base.x,
        cursor.base.y + HOVER_HEIGHT + bob,
        cursor.base.z
      )
      // Stable scale — opacity handles appear/disappear so fade-in no longer
      // reads as a loading pulse.
      cursor.group.scale.setScalar(1)
      cursor.coneMat.opacity = cursor.opacity
      cursor.coneOutlineMat.opacity = cursor.opacity
      cursor.labelMat.opacity = cursor.opacity

      const phase = p?.phase
      const hasConfirmedNote = Boolean(p?.note && p.noteConfirmed)
      const { showCheck, showNote, showSpinner } = getCursorStatusVisibility({
        active: Boolean(p?.active),
        phase,
        hasConfirmedNote,
      })
      const confirmedNote = hasConfirmedNote ? p?.note ?? '' : ''
      drawNote(cursor, confirmedNote)
      cursor.noteMat.opacity = showNote ? cursor.opacity : 0

      // The states are mutually exclusive and share one anchor:
      // intent → spinner, flying/working → feedback note, settling → check.
      if (showCheck && cursor.opacity > 0.02) {
        if (cursor.spinnerPhase !== 'settling') {
          cursor.spinnerMat.map = cursor.checkTex
          cursor.spinnerMat.rotation = 0
          cursor.spinnerMat.needsUpdate = true
          cursor.spinnerPhase = 'settling'
        }
        cursor.spinnerMat.opacity = cursor.opacity
      } else if (showSpinner && cursor.opacity > 0.02) {
        if (cursor.spinnerPhase !== 'active') {
          cursor.spinnerMat.map = cursor.arcTex
          cursor.spinnerMat.needsUpdate = true
          cursor.spinnerPhase = 'active'
        }
        if (!REDUCE_MOTION) cursor.spinnerMat.rotation = (now * SPINNER_SPEED) % (Math.PI * 2)
        cursor.spinnerMat.opacity = cursor.opacity
      } else {
        cursor.spinnerMat.opacity = 0
        cursor.spinnerPhase = undefined
      }
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
