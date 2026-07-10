/**
 * Desktop brutalist tokens baked for XR meshes (Three.js can't use CSS).
 * Mirrors src/index.css: --jsr-* , .brutalist-shadow, .overlay-panel, .panel-title.
 */
import * as THREE from 'three'

export const XR_UI = {
  ink: '#000000',
  paper: '#ffffff',
  yellow: '#FFE600',
  orange: '#FF6B00',
  blue: '#0094FF',
  pink: '#FF0090',
  bg: '#E8E8E8',
} as const

const MONO = 'bold 42px "JetBrains Mono", ui-monospace, monospace'
const MONO_LG = 'bold 56px "JetBrains Mono", ui-monospace, monospace'

export function makeCanvasTexture(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    draw(ctx, width, height)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  // No mipmaps — UI labels stay sharp when the panel is close in XR.
  tex.generateMipmaps = false
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.needsUpdate = true
  return tex
}

/** Hard offset shadow + filled card with thick black border (overlay-panel). */
export function drawBrutalCard(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  opts: { fill?: string; shadowPx?: number; borderPx?: number } = {}
): void {
  const fill = opts.fill ?? XR_UI.yellow
  const shadow = opts.shadowPx ?? 10
  const border = opts.borderPx ?? 8

  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = XR_UI.ink
  ctx.fillRect(shadow, shadow, w - shadow, h - shadow)
  ctx.fillStyle = fill
  ctx.fillRect(0, 0, w - shadow, h - shadow)
  ctx.strokeStyle = XR_UI.ink
  ctx.lineWidth = border
  ctx.strokeRect(border / 2, border / 2, w - shadow - border, h - shadow - border)
}

/** Transport / action button (black or yellow). */
export function makeButtonTexture(
  label: string,
  opts: { bg?: string; fg?: string; w?: number; h?: number; hover?: boolean } = {}
): THREE.CanvasTexture {
  const w = opts.w ?? 512
  const h = opts.h ?? 160
  const baseBg = opts.bg ?? XR_UI.ink
  const baseFg = opts.fg ?? XR_UI.paper
  const bg = opts.hover ? (baseBg === XR_UI.yellow ? XR_UI.ink : XR_UI.yellow) : baseBg
  const fg = opts.hover ? (baseBg === XR_UI.yellow ? XR_UI.yellow : XR_UI.ink) : baseFg

  return makeCanvasTexture(w, h, (ctx, cw, ch) => {
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, cw, ch)
    ctx.strokeStyle = XR_UI.ink
    ctx.lineWidth = 12
    ctx.strokeRect(6, 6, cw - 12, ch - 12)
    ctx.fillStyle = fg
    ctx.font = MONO_LG
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, cw / 2, ch / 2 + 2)
  })
}

/** Close control — yellow square + × (overlay-close). */
export function makeCloseTexture(hover = false): THREE.CanvasTexture {
  return makeCanvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = hover ? XR_UI.ink : XR_UI.yellow
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = XR_UI.ink
    ctx.lineWidth = 16
    ctx.strokeRect(8, 8, w - 16, h - 16)
    ctx.fillStyle = hover ? XR_UI.yellow : XR_UI.ink
    ctx.font = 'bold 140px "JetBrains Mono", monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('×', w / 2, h / 2 + 6)
  })
}

/** Scale handle — JSR blue + black border. */
export function makeScaleHandleTexture(): THREE.CanvasTexture {
  return makeCanvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = XR_UI.blue
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = XR_UI.ink
    ctx.lineWidth = 18
    ctx.strokeRect(9, 9, w - 18, h - 18)
    ctx.strokeStyle = XR_UI.paper
    ctx.lineWidth = 14
    ctx.beginPath()
    ctx.moveTo(w * 0.35, h * 0.65)
    ctx.lineTo(w * 0.65, h * 0.65)
    ctx.lineTo(w * 0.65, h * 0.35)
    ctx.stroke()
  })
}

/** Scrub track — white fill, black border. */
export function makeScrubTrackTexture(): THREE.CanvasTexture {
  return makeCanvasTexture(1024, 96, (ctx, w, h) => {
    ctx.fillStyle = XR_UI.paper
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = XR_UI.ink
    ctx.lineWidth = 10
    ctx.strokeRect(5, 5, w - 10, h - 10)
  })
}

/** Orange playhead block. */
export function makePlayheadTexture(): THREE.CanvasTexture {
  return makeCanvasTexture(96, 160, (ctx, w, h) => {
    ctx.fillStyle = XR_UI.orange
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = XR_UI.ink
    ctx.lineWidth = 10
    ctx.strokeRect(5, 5, w - 10, h - 10)
  })
}

/**
 * Review card chrome only — yellow body, film hole, dock strip.
 * Title is a separate mesh (avoid double "TAKE REVIEW").
 */
export function makeReviewCardTexture(): THREE.CanvasTexture {
  return makeCanvasTexture(2048, 1536, (ctx, w, h) => {
    drawBrutalCard(ctx, w, h, { fill: XR_UI.yellow, shadowPx: 28, borderPx: 16 })

    const pad = 48
    const shadow = 28
    const innerW = w - shadow - pad * 2
    // Leave header band empty for the skewed title mesh.
    const headerH = 96
    const bezelTop = pad + headerH
    const bezelH = Math.floor(innerW * (9 / 16))
    const bezelX = pad
    ctx.fillStyle = XR_UI.ink
    ctx.fillRect(bezelX, bezelTop, innerW, bezelH)
    ctx.fillStyle = '#111111'
    ctx.fillRect(bezelX + 16, bezelTop + 16, innerW - 32, bezelH - 32)

    const dockY = bezelTop + bezelH + 28
    const dockH = h - shadow - dockY - pad
    ctx.fillStyle = XR_UI.paper
    ctx.fillRect(bezelX, dockY, innerW, Math.max(dockH, 64))
    ctx.strokeStyle = XR_UI.ink
    ctx.lineWidth = 10
    ctx.strokeRect(bezelX + 5, dockY + 5, innerW - 10, Math.max(dockH, 64) - 10)
  })
}

/** PiP-style badge: white chip, black border, mono label. Optional REC slot on the right. */
export function makeBadgeTexture(
  label: string,
  opts: { recDot?: boolean } = {}
): THREE.CanvasTexture {
  return makeCanvasTexture(720, 128, (ctx, w, h) => {
    ctx.fillStyle = XR_UI.paper
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = XR_UI.ink
    ctx.lineWidth = 10
    ctx.strokeRect(5, 5, w - 10, h - 10)
    ctx.fillStyle = XR_UI.ink
    ctx.font = MONO
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, 28, h / 2 + 2)
    if (opts.recDot) {
      ctx.fillStyle = '#FF0000'
      ctx.beginPath()
      ctx.arc(w - 48, h / 2, 22, 0, Math.PI * 2)
      ctx.fill()
    }
  })
}
