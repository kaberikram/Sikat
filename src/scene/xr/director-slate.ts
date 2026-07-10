/**
 * Compact DIRECTOR_LINK slate under the grip viewfinder — status + live STT box.
 */
import * as THREE from 'three'
import { setEditorLayer } from '../infrastructure'
import { makeCanvasTexture, XR_UI } from './xr-ui-chrome'

const SLATE_W = 0.14
const SLATE_H = 0.048
const TEX_W = 896
const TEX_H = 308

export interface DirectorSlate {
  group: THREE.Group
  setListening: (on: boolean) => void
  setInterim: (text: string) => void
  setLastSent: (text: string) => void
  setOffline: (on: boolean) => void
  dispose: () => void
}

function paintSlate(opts: {
  listening: boolean
  interim: string
  lastSent: string
  offline: boolean
}): THREE.CanvasTexture {
  return makeCanvasTexture(TEX_W, TEX_H, (ctx, w, h) => {
    // Card body
    ctx.fillStyle = XR_UI.ink
    ctx.fillRect(8, 8, w - 8, h - 8)
    ctx.fillStyle = XR_UI.paper
    ctx.fillRect(0, 0, w - 8, h - 8)
    ctx.strokeStyle = XR_UI.ink
    ctx.lineWidth = 10
    ctx.strokeRect(5, 5, w - 18, h - 18)

    // Status strip
    const stripH = 72
    ctx.fillStyle = XR_UI.ink
    ctx.fillRect(10, 10, w - 28, stripH)

    const statusColor = opts.offline
      ? '#ff3b30'
      : opts.listening
        ? XR_UI.orange
        : '#30d158'
    ctx.fillStyle = statusColor
    ctx.beginPath()
    ctx.arc(48, 10 + stripH / 2, 14, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = XR_UI.paper
    ctx.font = 'bold 36px "JetBrains Mono", monospace'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    const label = opts.offline
      ? 'OFFLINE'
      : opts.listening
        ? 'LISTENING'
        : 'DIRECTOR'
    ctx.fillText(label, 78, 10 + stripH / 2 + 2)

    ctx.fillStyle = '#888888'
    ctx.font = 'bold 28px "JetBrains Mono", monospace'
    ctx.textAlign = 'right'
    ctx.fillText(opts.listening ? 'HOLD A' : 'HOLD A · TALK', w - 36, 10 + stripH / 2 + 2)

    // Transcript box
    const boxY = stripH + 22
    const boxH = h - boxY - 24
    ctx.fillStyle = XR_UI.paper
    ctx.fillRect(18, boxY, w - 44, boxH)
    ctx.strokeStyle = XR_UI.ink
    ctx.lineWidth = 6
    ctx.strokeRect(21, boxY + 3, w - 50, boxH - 6)

    const line = opts.listening
      ? (opts.interim.trim() || '…')
      : (opts.lastSent.trim() || 'say a direction…')
    const isGhost = opts.listening && !opts.interim.trim()
    const isInterim = opts.listening && Boolean(opts.interim.trim())
    ctx.fillStyle = isGhost || isInterim ? '#888888' : XR_UI.ink
    ctx.font = 'bold 32px "JetBrains Mono", monospace'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'

    // Simple wrap
    const maxW = w - 70
    const words = line.split(/\s+/)
    let row = ''
    let y = boxY + boxH / 2 - 18
    const rows: string[] = []
    for (const word of words) {
      const next = row ? `${row} ${word}` : word
      if (ctx.measureText(next).width > maxW && row) {
        rows.push(row)
        row = word
      } else {
        row = next
      }
    }
    if (row) rows.push(row)
    const show = rows.slice(0, 2)
    if (show.length === 1) y = boxY + boxH / 2 + 2
    for (let i = 0; i < show.length; i++) {
      ctx.fillText(show[i], 34, y + i * 36)
    }
  })
}

export function createDirectorSlate(parent: THREE.Object3D): DirectorSlate {
  const group = new THREE.Group()
  group.position.set(0, -0.055, 0.002)
  parent.add(group)

  let listening = false
  let interim = ''
  let lastSent = ''
  let offline = false
  let lastPaint = 0

  let tex = paintSlate({ listening, interim, lastSent, offline })
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    toneMapped: false,
    depthTest: false,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(SLATE_W, SLATE_H), mat)
  mesh.renderOrder = 13
  group.add(mesh)
  setEditorLayer(group)

  function repaint(force = false): void {
    const now = performance.now()
    if (!force && now - lastPaint < 80) return
    lastPaint = now
    const next = paintSlate({ listening, interim, lastSent, offline })
    mat.map = next
    mat.needsUpdate = true
    tex.dispose()
    tex = next
  }

  return {
    group,
    setListening: (on) => {
      listening = on
      if (!on) interim = ''
      repaint(true)
    },
    setInterim: (text) => {
      interim = text
      repaint()
    },
    setLastSent: (text) => {
      lastSent = text
      repaint(true)
    },
    setOffline: (on) => {
      offline = on
      repaint(true)
    },
    dispose: () => {
      group.removeFromParent()
      mesh.geometry.dispose()
      mat.map?.dispose()
      mat.dispose()
    },
  }
}
