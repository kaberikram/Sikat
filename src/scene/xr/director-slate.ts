/**
 * Compact DIRECTOR_LINK slate under the grip viewfinder — status + live STT box.
 */
import * as THREE from 'three'
import { setEditorLayer } from '../infrastructure'
import { drawGlassCard, makeCanvasTexture, XR_UI } from './xr-ui-chrome'

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
    // Glass card body
    drawGlassCard(ctx, w, h, { pad: 18, radius: 44 })

    // Status pill — pastel-coded by state, ink label.
    const stripH = 68
    const stripY = 34
    const stripColor = opts.offline
      ? XR_UI.rec
      : opts.listening
        ? XR_UI.sun
        : XR_UI.mint
    ctx.fillStyle = stripColor
    ctx.beginPath()
    ctx.roundRect(34, stripY, w - 68, stripH, stripH / 2)
    ctx.fill()

    const dotColor = opts.offline
      ? '#ffffff'
      : opts.listening
        ? XR_UI.sunDeep
        : XR_UI.mintDeep
    ctx.fillStyle = dotColor
    ctx.beginPath()
    ctx.arc(70, stripY + stripH / 2, 13, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = opts.offline ? '#ffffff' : XR_UI.ink
    ctx.font = '700 36px "Baloo 2", ui-rounded, system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    const label = opts.offline
      ? 'OFFLINE'
      : opts.listening
        ? 'LISTENING'
        : 'DIRECTOR'
    ctx.fillText(label, 98, stripY + stripH / 2 + 3)

    ctx.fillStyle = opts.offline ? 'rgba(255,255,255,0.8)' : XR_UI.inkSoft
    ctx.font = '600 28px "Baloo 2", ui-rounded, system-ui, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(opts.listening ? 'HOLD A' : 'HOLD A · TALK', w - 56, stripY + stripH / 2 + 3)

    // Transcript box — inner soft-white rounded well.
    const boxY = stripY + stripH + 18
    const boxH = h - boxY - 40
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)'
    ctx.beginPath()
    ctx.roundRect(34, boxY, w - 68, boxH, 28)
    ctx.fill()

    const line = opts.listening
      ? (opts.interim.trim() || '…')
      : (opts.lastSent.trim() || 'say a direction…')
    const isGhost = opts.listening && !opts.interim.trim()
    const isInterim = opts.listening && Boolean(opts.interim.trim())
    ctx.fillStyle = isGhost || isInterim ? XR_UI.inkSoft : XR_UI.ink
    ctx.font = '600 32px "Baloo 2", ui-rounded, system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'

    // Simple wrap
    const maxW = w - 120
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
      ctx.fillText(show[i], 58, y + i * 36)
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
