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
 *
 * Anonymous pending cursors (pre-server) are unlabeled gray cones with a
 * spinner; when the named agent appears it snaps to the pending position.
 */
import * as THREE from 'three'
import {
  presenceStore,
  CURSOR_AGENT_ORDER,
  agentMetaFor,
  cursorVisible,
  type CursorPhase,
} from '../director/presence'
import { sampleObjectAtTime } from '../director/scene-state-sync'
import { useEditorStore } from '../store'
import { getEaseFn } from '../easing'
import { tagSceneInfrastructure, setEditorLayer } from './infrastructure'
import { drawGlassCard, drawPill, makeCanvasTexture, XR_UI } from './xr/xr-ui-chrome'
import { getCursorStatusVisibility } from './agent-cursor-status'
import { dampToward } from './opacity-damp'

/** Film-set badge names — display only; agent ids stay canonical everywhere. */
const DISPLAY_NAMES: Record<string, string> = {
  AssetAnimator: 'ANIMATOR',
  LightingTech: 'GAFFER',
  VFXOperator: 'VFX',
}

function displayNameFor(agent: string): string {
  return DISPLAY_NAMES[agent] ?? agent
}

const HOVER_HEIGHT = 0.22
const STATUS_SLOT_Y = 0.18
const LABEL_Y = 0.3
const PENDING_COLOR = '#888888'
const flightEase = getEaseFn('easeOut')

/** Named cursor fade-in time constant (slower than the old 0.22/frame snap). */
const CURSOR_FADE_IN_TAU_MS = 320
/** Named cursor soft exit — deliberately longer than entrance. */
const CURSOR_FADE_OUT_TAU_MS = 720
/** Pending exits faster so the named replacement can crossfade without a pop. */
const PENDING_FADE_OUT_TAU_MS = 260

const REDUCE_MOTION =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

const SPINNER_SPEED = 0.006 // radians per ms

interface ConeParts {
  coneMat: THREE.MeshBasicMaterial
  coneOutlineMat: THREE.MeshBasicMaterial
}

interface SpinnerParts {
  spinnerMat: THREE.SpriteMaterial
  arcTex: THREE.CanvasTexture
  checkTex: THREE.CanvasTexture
  spinner: THREE.Sprite
}

interface Cursor {
  group: THREE.Group
  coneMat: THREE.MeshBasicMaterial
  coneOutlineMat: THREE.MeshBasicMaterial
  labelMat: THREE.SpriteMaterial | null
  base: THREE.Vector3
  from: THREE.Vector3
  moveStartedAt: number
  seed: number
  opacity: number
  wasVisible: boolean
  noteMat: THREE.SpriteMaterial | null
  noteSprite: THREE.Sprite | null
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
    ctx.clearRect(0, 0, w, h)
    drawPill(ctx, 16, 16, w - 32, h - 32, color, { pad: 16 })
    ctx.fillStyle = XR_UI.ink
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    let fontPx = 64
    do {
      ctx.font = `700 ${fontPx}px "Baloo 2", ui-rounded, system-ui, sans-serif`
      fontPx -= 2
    } while (fontPx > 24 && ctx.measureText(label).width > w - 96)
    ctx.fillText(label, w / 2, h / 2 - 2)
  })
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(0.5, 0.104, 1)
  return { sprite, material }
}

/** Thick open arc — rotated each frame to read as a spinner. Drawn once. */
function makeArcTexture(color: string): THREE.CanvasTexture {
  return makeCanvasTexture(160, 160, (ctx) => {
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
    ctx.lineWidth = 28
    ctx.arc(80, 80, 54, Math.PI * 0.3, Math.PI * 1.8)
    ctx.stroke()
    ctx.beginPath()
    ctx.strokeStyle = color
    ctx.lineWidth = 16
    ctx.arc(80, 80, 54, Math.PI * 0.3, Math.PI * 1.8)
    ctx.stroke()
  })
}

/** Check mark — swapped in on settle so completion reads instantly. */
function makeCheckTexture(color: string): THREE.CanvasTexture {
  return makeCanvasTexture(160, 160, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h)
    ctx.save()
    ctx.shadowColor = XR_UI.shadow
    ctx.shadowBlur = 14
    ctx.shadowOffsetY = 5
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(w / 2, h / 2, w / 2 - 16, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 16
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(44, 84)
    ctx.lineTo(70, 110)
    ctx.lineTo(118, 54)
    ctx.stroke()
  })
}

function makeCone(color: string): ConeParts & { cone: THREE.Mesh; outline: THREE.Mesh } {
  const coneOutlineMat = new THREE.MeshBasicMaterial({ color, transparent: true })
  const outline = new THREE.Mesh(new THREE.ConeGeometry(0.066, 0.185, 24), coneOutlineMat)
  outline.rotation.x = Math.PI
  outline.castShadow = false
  outline.receiveShadow = false

  const coneMat = new THREE.MeshBasicMaterial({ color, transparent: true })
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.17, 24), coneMat)
  cone.rotation.x = Math.PI
  cone.castShadow = false
  cone.receiveShadow = false

  return { coneMat, coneOutlineMat, cone, outline }
}

function makeSpinner(color: string): SpinnerParts {
  const arcTex = makeArcTexture(color)
  const checkTex = makeCheckTexture(color)
  const spinnerMat = new THREE.SpriteMaterial({
    map: arcTex,
    transparent: true,
    depthTest: false,
    opacity: 0,
  })
  const spinner = new THREE.Sprite(spinnerMat)
  spinner.scale.set(0.12, 0.12, 1)
  spinner.position.set(0, STATUS_SLOT_Y, 0)
  return { spinnerMat, arcTex, checkTex, spinner }
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
  if (!cursor.noteMat || !cursor.noteSprite) return
  if (cursor.noteText === text) return
  cursor.noteText = text
  cursor.noteMat.map?.dispose()
  if (!text) {
    cursor.noteMat.map = makeCanvasTexture(2, 2, () => {})
    cursor.noteSprite.scale.set(0.01, 0.01, 1)
    cursor.noteMat.needsUpdate = true
    return
  }

  const font = '600 44px "Baloo 2", ui-rounded, system-ui, sans-serif'
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
    drawGlassCard(ctx, w, h, { pad: 16, radius: 44 })
    ctx.fillStyle = XR_UI.ink
    ctx.font = font
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const startY = h / 2 - ((lines.length - 1) * lineH) / 2
    lines.forEach((line, index) => ctx.fillText(line, w / 2, startY + index * lineH))
  })
  cursor.noteMat.map = texture
  cursor.noteMat.needsUpdate = true
  const worldH = lines.length === 2 ? 0.14 : 0.1
  cursor.noteSprite.scale.set(worldH * (cardW / cardH), worldH, 1)
}

function buildCursor(agent: string, seed: number): Cursor {
  const { color, station } = agentMetaFor(agent)
  const group = new THREE.Group()

  const { coneMat, coneOutlineMat, cone, outline } = makeCone(color)
  group.add(outline)
  group.add(cone)

  const { sprite, material: labelMat } = makeLabel(displayNameFor(agent), color)
  sprite.position.set(0, LABEL_Y, 0)
  group.add(sprite)

  const { sprite: noteSprite, material: noteMat } = makeNote()
  group.add(noteSprite)

  const { spinnerMat, arcTex, checkTex, spinner } = makeSpinner(color)
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
    wasVisible: false,
    noteMat,
    noteSprite,
    noteText: '',
    spinnerMat,
    arcTex,
    checkTex,
    spinnerPhase: undefined,
  }
}

function buildPendingCursor(seed: number): Cursor {
  // Not a cursor at all — a small "listening dot" that breathes above the
  // anchor. Reads as "the set heard you", never as a broken gray ghost.
  const group = new THREE.Group()
  const coneMat = new THREE.MeshBasicMaterial({
    color: XR_UI.mint,
    transparent: true,
    depthTest: false,
  })
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.015, 16, 16), coneMat)
  group.add(dot)
  const coneOutlineMat = new THREE.MeshBasicMaterial({
    color: '#ffffff',
    transparent: true,
    opacity: 0.35,
    depthTest: false,
  })
  const halo = new THREE.Mesh(new THREE.SphereGeometry(0.024, 16, 16), coneOutlineMat)
  group.add(halo)

  const { spinnerMat, arcTex, checkTex, spinner } = makeSpinner(PENDING_COLOR)
  spinner.visible = false
  group.add(spinner)

  group.renderOrder = 999
  setEditorLayer(group)
  tagSceneInfrastructure(group)
  group.visible = false

  return {
    group,
    coneMat,
    coneOutlineMat,
    labelMat: null,
    base: new THREE.Vector3(0, 0, 0),
    from: new THREE.Vector3(0, 0, 0),
    moveStartedAt: 0,
    seed,
    opacity: 0,
    wasVisible: false,
    noteMat: null,
    noteSprite: null,
    noteText: '',
    spinnerMat,
    arcTex,
    checkTex,
    spinnerPhase: undefined,
  }
}

function disposeCursorGroup(scene: THREE.Scene, cursor: Cursor): void {
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

function updateStatusChrome(
  cursor: Cursor,
  now: number,
  opts: { showCheck: boolean; showNote: boolean; showSpinner: boolean; note: string }
): void {
  drawNote(cursor, opts.note)
  if (cursor.noteMat) cursor.noteMat.opacity = opts.showNote ? cursor.opacity : 0

  if (opts.showCheck && cursor.opacity > 0.02) {
    if (cursor.spinnerPhase !== 'settling') {
      cursor.spinnerMat.map = cursor.checkTex
      cursor.spinnerMat.rotation = 0
      cursor.spinnerMat.needsUpdate = true
      cursor.spinnerPhase = 'settling'
    }
    cursor.spinnerMat.opacity = cursor.opacity
  } else if (opts.showSpinner && cursor.opacity > 0.02) {
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

export interface AgentCursors {
  update(now: number): void
  dispose(): void
}

export function createAgentCursors(scene: THREE.Scene): AgentCursors {
  const cursors = new Map<string, Cursor>()
  const pendingCursors = new Map<string, Cursor>()
  let cursorSeed = 0
  let lastNow = 0

  function ensureCursor(agent: string): Cursor {
    let cursor = cursors.get(agent)
    if (cursor) return cursor
    cursor = buildCursor(agent, cursorSeed++)
    cursors.set(agent, cursor)
    scene.add(cursor.group)
    return cursor
  }

  function ensurePending(commandId: string): Cursor {
    let cursor = pendingCursors.get(commandId)
    if (cursor) return cursor
    cursor = buildPendingCursor(cursorSeed++)
    pendingCursors.set(commandId, cursor)
    scene.add(cursor.group)
    return cursor
  }

  CURSOR_AGENT_ORDER.forEach((agent) => {
    ensureCursor(agent)
  })

  const update = (now: number) => {
    const state = presenceStore.getState()
    const agents = state.agents
    const pending = state.pending
    const editor = useEditorStore.getState()
    const dtMs = lastNow > 0 ? Math.min(50, Math.max(0, now - lastNow)) : 1000 / 60
    lastNow = now

    for (const agent of Object.keys(agents)) {
      if (cursorVisible(agent)) ensureCursor(agent)
    }

    for (const commandId of Object.keys(pending)) {
      ensurePending(commandId)
    }

    for (const [commandId, cursor] of pendingCursors) {
      const entry = pending[commandId]
      const wantOpacity = entry ? 1 : 0
      const tauMs = wantOpacity > cursor.opacity ? CURSOR_FADE_IN_TAU_MS : PENDING_FADE_OUT_TAU_MS
      cursor.opacity = dampToward(cursor.opacity, wantOpacity, dtMs, tauMs)

      if (!entry && cursor.opacity < 0.01) {
        disposeCursorGroup(scene, cursor)
        pendingCursors.delete(commandId)
        continue
      }
      if (cursor.opacity < 0.01) {
        cursor.group.visible = false
        continue
      }
      cursor.group.visible = true
      if (entry) {
        if (!cursor.wasVisible) {
          cursor.base.set(entry.position[0], entry.position[1], entry.position[2])
          cursor.from.copy(cursor.base)
          cursor.wasVisible = true
        } else {
          cursor.base.set(entry.position[0], entry.position[1], entry.position[2])
        }
      }
      const bob = REDUCE_MOTION ? 0 : Math.sin(now / 320 + cursor.seed) * 0.02
      cursor.group.position.set(
        cursor.base.x,
        cursor.base.y + HOVER_HEIGHT + bob,
        cursor.base.z
      )
      // Breathing: gentle scale + opacity pulse, transform-only.
      const breath = REDUCE_MOTION ? 1 : 1 + Math.sin(now / 420 + cursor.seed) * 0.25
      cursor.group.scale.setScalar(breath)
      cursor.coneMat.opacity = cursor.opacity * 0.9
      cursor.coneOutlineMat.opacity = cursor.opacity * 0.3
    }

    for (const [agent, cursor] of cursors) {
      if (!cursorVisible(agent)) continue
      const p = agents[agent]
      const isVisible = Boolean(p?.active && p.idleMode !== 'faded')
      const wantOpacity = isVisible ? 1 : 0
      const tauMs = wantOpacity > cursor.opacity ? CURSOR_FADE_IN_TAU_MS : CURSOR_FADE_OUT_TAU_MS
      cursor.opacity = dampToward(cursor.opacity, wantOpacity, dtMs, tauMs)

      if (wantOpacity === 0 && cursor.opacity < 0.01) {
        cursor.group.visible = false
        cursor.wasVisible = false
        continue
      }
      cursor.group.visible = true

      // Snap from/base when a cursor goes invisible → visible (appearAt handoff).
      if (isVisible && !cursor.wasVisible && p) {
        const start = p.appearFrom ?? p.target
        cursor.base.set(start[0], start[1], start[2])
        cursor.from.copy(cursor.base)
        cursor.moveStartedAt = p.moveStartedAt
        cursor.wasVisible = true
        if (p.appearFrom) presenceStore.getState().clearAppearFrom(agent)
      } else if (!isVisible) {
        cursor.wasVisible = false
      }

      if (p?.followObjectId) {
        const obj = editor.objects.find((o) => o.id === p.followObjectId)
        if (obj) {
          const sampled = sampleObjectAtTime(obj, editor.currentTime)
          cursor.base.set(sampled.position[0], sampled.position[1], sampled.position[2])
        }
      } else if (p) {
        if (p.moveStartedAt !== cursor.moveStartedAt) {
          cursor.from.copy(cursor.base)
          cursor.moveStartedAt = p.moveStartedAt
        }
        const durationMs = p.moveDurationMs > 0 ? p.moveDurationMs : 1
        const elapsed = p.moveStartedAt > 0 ? now - p.moveStartedAt : durationMs
        const ease = p.phase === 'intent' ? getEaseFn('easeOut') : flightEase
        const alpha =
          p.moveDurationMs <= 0 ? 1 : ease(Math.min(1, Math.max(0, elapsed / durationMs)))
        cursor.base.set(
          cursor.from.x + (p.target[0] - cursor.from.x) * alpha,
          cursor.from.y + (p.target[1] - cursor.from.y) * alpha,
          cursor.from.z + (p.target[2] - cursor.from.z) * alpha
        )
      }

      const bob = REDUCE_MOTION ? 0 : Math.sin(now / 320 + cursor.seed) * 0.05
      // Slow, tiny station drift so an idle crew never reads as frozen.
      // Small enough (~6cm) to be invisible during flights.
      const driftX = REDUCE_MOTION ? 0 : Math.sin(now / 4700 + cursor.seed * 3.1) * 0.06
      const driftZ = REDUCE_MOTION ? 0 : Math.cos(now / 5600 + cursor.seed * 2.3) * 0.06
      cursor.group.position.set(
        cursor.base.x + driftX,
        cursor.base.y + HOVER_HEIGHT + bob,
        cursor.base.z + driftZ
      )
      cursor.group.scale.setScalar(1)
      cursor.coneMat.opacity = cursor.opacity
      cursor.coneOutlineMat.opacity = cursor.opacity
      if (cursor.labelMat) cursor.labelMat.opacity = cursor.opacity

      const phase = p?.phase as CursorPhase | undefined
      const hasConfirmedNote = Boolean(p?.note && p.noteConfirmed)
      const { showCheck, showNote, showSpinner } = getCursorStatusVisibility({
        active: Boolean(p?.active),
        phase,
        hasConfirmedNote,
      })
      const confirmedNote = hasConfirmedNote ? p?.note ?? '' : ''
      updateStatusChrome(cursor, now, {
        showCheck,
        showNote,
        showSpinner,
        note: confirmedNote,
      })
    }
  }

  const dispose = () => {
    for (const cursor of cursors.values()) disposeCursorGroup(scene, cursor)
    cursors.clear()
    for (const cursor of pendingCursors.values()) disposeCursorGroup(scene, cursor)
    pendingCursors.clear()
  }

  return { update, dispose }
}
