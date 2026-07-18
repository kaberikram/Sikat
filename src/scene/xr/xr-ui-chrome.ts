/**
 * Pastel-glass tokens baked for XR meshes (Three.js can't use CSS).
 * Mirrors src/index.css: --color-ink / --color-candy-* / --shadow-soft.
 * Panels are visionOS-style faux frost: translucent rounded cards with a
 * painted soft shadow (no real backdrop blur — not worth it in XR).
 */
import * as THREE from 'three'

export const XR_UI = {
  ink: '#3B3A48',
  inkSoft: '#7A7786',
  paper: '#FFFDF9',
  glass: 'rgba(255, 253, 249, 0.88)',
  glassStroke: 'rgba(255, 255, 255, 0.85)',
  pink: '#FFB1CE',
  pinkDeep: '#F27BAC',
  blue: '#A8D8FF',
  blueDeep: '#5EAEF2',
  mint: '#B9EBD3',
  mintDeep: '#57CFA0',
  sun: '#FFE092',
  sunDeep: '#FFC43D',
  rec: '#FF6B7E',
  screen: '#2E2D38',
  shadow: 'rgba(59, 58, 72, 0.3)',
} as const

const SANS = '600 44px "Baloo 2", ui-rounded, system-ui, sans-serif'
const SANS_LG = '700 56px "Baloo 2", ui-rounded, system-ui, sans-serif'
export const XR_FONT_SANS = SANS
export const XR_FONT_SANS_LG = SANS_LG
export const XR_FONT_MONO = 'bold 36px "JetBrains Mono", ui-monospace, monospace'

const FONT_PROBE = '700 56px "Baloo 2"'

/** Kick off Baloo 2 loading before any XR canvas rasterizes — call at app boot. */
export function preloadXrUiFonts(): void {
  if (typeof document === 'undefined' || !('fonts' in document)) return
  void document.fonts.load('600 44px "Baloo 2"')
  void document.fonts.load(FONT_PROBE)
}

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

  // Labels painted before Baloo 2 arrives rasterize the fallback font —
  // repaint once the font face is ready.
  if (ctx && 'fonts' in document && !document.fonts.check(FONT_PROBE)) {
    void document.fonts.ready.then(() => {
      ctx.clearRect(0, 0, width, height)
      draw(ctx, width, height)
      tex.needsUpdate = true
    })
  }
  return tex
}

export interface LiveCanvasTexture {
  texture: THREE.CanvasTexture
  /** Redraw into the same canvas + GPU texture — no allocation per update. */
  repaint: (draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) => void
  dispose: () => void
}

/**
 * A canvas texture meant to be repainted often (live transcripts, meters).
 * Unlike makeCanvasTexture it never reallocates — repaint() redraws in place
 * and flags needsUpdate, so hot paths don't churn canvases/GPU uploads.
 */
export function makeLiveCanvasTexture(width: number, height: number): LiveCanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.generateMipmaps = false
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter

  let lastDraw: ((ctx: CanvasRenderingContext2D, w: number, h: number) => void) | null = null

  const repaint: LiveCanvasTexture['repaint'] = (draw) => {
    lastDraw = draw
    if (!ctx) return
    ctx.clearRect(0, 0, width, height)
    draw(ctx, width, height)
    tex.needsUpdate = true
  }

  // Repaint once the real font lands so early paints don't keep the fallback.
  if (ctx && 'fonts' in document && !document.fonts.check(FONT_PROBE)) {
    void document.fonts.ready.then(() => {
      if (lastDraw) repaint(lastDraw)
    })
  }

  return {
    texture: tex,
    repaint,
    dispose: () => {
      lastDraw = null
      tex.dispose()
    },
  }
}

/**
 * Faux-frost glass card: soft painted shadow + translucent rounded fill +
 * bright hairline stroke + top-edge highlight. `pad` reserves transparent
 * margin on all sides so the shadow can bleed without clipping.
 */
export function drawGlassCard(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  opts: { fill?: string; radius?: number; pad?: number } = {}
): void {
  const pad = opts.pad ?? 48
  const radius = opts.radius ?? 64
  const fill = opts.fill ?? XR_UI.glass
  const cw = w - pad * 2
  const ch = h - pad * 2

  ctx.clearRect(0, 0, w, h)

  ctx.save()
  ctx.shadowColor = XR_UI.shadow
  ctx.shadowBlur = pad * 0.8
  ctx.shadowOffsetY = pad * 0.3
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.roundRect(pad, pad, cw, ch, radius)
  ctx.fill()
  ctx.restore()

  ctx.strokeStyle = XR_UI.glassStroke
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.roundRect(pad + 1.5, pad + 1.5, cw - 3, ch - 3, Math.max(radius - 1.5, 0))
  ctx.stroke()

  // Top-edge highlight
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(pad, pad, cw, ch, radius)
  ctx.clip()
  const hl = ctx.createLinearGradient(0, pad, 0, pad + ch * 0.28)
  hl.addColorStop(0, 'rgba(255, 255, 255, 0.55)')
  hl.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = hl
  ctx.fillRect(pad, pad, cw, ch * 0.28)
  ctx.restore()
}

/** Pill fill + soft shadow, with hover = glow + gentle lighten (no inversion). */
export function drawPill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  opts: { hover?: boolean; pad?: number } = {}
): void {
  const r = h / 2
  ctx.save()
  if (opts.hover) {
    ctx.shadowColor = fill
    ctx.shadowBlur = (opts.pad ?? 24) * 1.1
  } else {
    ctx.shadowColor = XR_UI.shadow
    ctx.shadowBlur = (opts.pad ?? 24) * 0.7
    ctx.shadowOffsetY = (opts.pad ?? 24) * 0.25
  }
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
  ctx.fill()
  ctx.restore()
  if (opts.hover) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.22)'
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, r)
    ctx.fill()
  }
}

/** Transport / action pill button. Default: sunny yellow with ink label. */
export function makeButtonTexture(
  label: string,
  opts: { bg?: string; fg?: string; w?: number; h?: number; hover?: boolean } = {}
): THREE.CanvasTexture {
  const w = opts.w ?? 576
  const h = opts.h ?? 192
  const pad = 28
  const bg = opts.bg ?? XR_UI.sun
  const fg = opts.fg ?? XR_UI.ink

  return makeCanvasTexture(w, h, (ctx, cw, ch) => {
    ctx.clearRect(0, 0, cw, ch)
    drawPill(ctx, pad, pad, cw - pad * 2, ch - pad * 2, bg, { hover: opts.hover, pad })
    ctx.fillStyle = fg
    ctx.font = SANS_LG
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, cw / 2, ch / 2 + 4)
  })
}

/** Close control — translucent disk + soft ×. */
export function makeCloseTexture(hover = false): THREE.CanvasTexture {
  return makeCanvasTexture(256, 256, (ctx, w, h) => {
    const pad = 28
    const r = (Math.min(w, h) - pad * 2) / 2
    ctx.clearRect(0, 0, w, h)
    ctx.save()
    if (hover) {
      ctx.shadowColor = XR_UI.shadow
      ctx.shadowBlur = 30
    } else {
      ctx.shadowColor = XR_UI.shadow
      ctx.shadowBlur = 20
      ctx.shadowOffsetY = 8
    }
    ctx.fillStyle = hover ? 'rgba(59, 58, 72, 0.16)' : 'rgba(255, 255, 255, 0.7)'
    ctx.beginPath()
    ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    ctx.strokeStyle = XR_UI.glassStroke
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.arc(w / 2, h / 2, r - 1.5, 0, Math.PI * 2)
    ctx.stroke()
    ctx.strokeStyle = hover ? XR_UI.ink : XR_UI.inkSoft
    ctx.lineWidth = 14
    ctx.lineCap = 'round'
    const a = r * 0.42
    ctx.beginPath()
    ctx.moveTo(w / 2 - a, h / 2 - a)
    ctx.lineTo(w / 2 + a, h / 2 + a)
    ctx.moveTo(w / 2 + a, h / 2 - a)
    ctx.lineTo(w / 2 - a, h / 2 + a)
    ctx.stroke()
  })
}

/** Scale handle — candy-blue disk with a white corner arrow. */
export function makeScaleHandleTexture(): THREE.CanvasTexture {
  return makeCanvasTexture(256, 256, (ctx, w, h) => {
    const pad = 28
    const r = (Math.min(w, h) - pad * 2) / 2
    ctx.clearRect(0, 0, w, h)
    ctx.save()
    ctx.shadowColor = XR_UI.shadow
    ctx.shadowBlur = 20
    ctx.shadowOffsetY = 8
    ctx.fillStyle = XR_UI.blue
    ctx.beginPath()
    ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    ctx.strokeStyle = XR_UI.glassStroke
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.arc(w / 2, h / 2, r - 1.5, 0, Math.PI * 2)
    ctx.stroke()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 14
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(w * 0.38, h * 0.62)
    ctx.lineTo(w * 0.62, h * 0.62)
    ctx.lineTo(w * 0.62, h * 0.38)
    ctx.stroke()
  })
}

/** Scrub track — soft translucent pill groove. */
export function makeScrubTrackTexture(): THREE.CanvasTexture {
  return makeCanvasTexture(1024, 96, (ctx, w, h) => {
    const pad = 10
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(59, 58, 72, 0.12)'
    ctx.beginPath()
    ctx.roundRect(pad, pad, w - pad * 2, h - pad * 2, (h - pad * 2) / 2)
    ctx.fill()
  })
}

/** Playhead — round white thumb with a sunny ring. */
export function makePlayheadTexture(): THREE.CanvasTexture {
  return makeCanvasTexture(160, 160, (ctx, w, h) => {
    const pad = 22
    const r = (Math.min(w, h) - pad * 2) / 2
    ctx.clearRect(0, 0, w, h)
    ctx.save()
    ctx.shadowColor = XR_UI.shadow
    ctx.shadowBlur = 16
    ctx.shadowOffsetY = 6
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    ctx.strokeStyle = XR_UI.sunDeep
    ctx.lineWidth = 12
    ctx.beginPath()
    ctx.arc(w / 2, h / 2, r - 6, 0, Math.PI * 2)
    ctx.stroke()
  })
}

/** Title chip — sunny pill with ink Baloo label (replaces the black slab). */
export function makeTitleTexture(
  label: string,
  opts: { w?: number; h?: number } = {}
): THREE.CanvasTexture {
  const w = opts.w ?? 840
  const h = opts.h ?? 144
  return makeCanvasTexture(w, h, (ctx, cw, ch) => {
    ctx.clearRect(0, 0, cw, ch)
    const pad = 20
    drawPill(ctx, pad, pad, cw - pad * 2, ch - pad * 2, XR_UI.sun, { pad })
    ctx.fillStyle = XR_UI.ink
    ctx.font = SANS_LG
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, cw / 2, ch / 2 + 4)
  })
}

/**
 * Review card chrome only — glass body, rounded screen bezel, dock groove.
 * Title is a separate mesh (avoid double "TAKE REVIEW").
 */
export function makeReviewCardTexture(): THREE.CanvasTexture {
  return makeCanvasTexture(2048, 1536, (ctx, w, h) => {
    const glassPad = 48
    drawGlassCard(ctx, w, h, { pad: glassPad, radius: 88 })

    // Bezel + dock positions mirror the mesh layout constants in
    // review-screen.ts (card 1.35×1.01 world → 2048×1536 px):
    // screen FILM_W×FILM_H (1.12×0.63) centered at y=FILM_Y (0.08),
    // transport row at y=DOCK_Y (−0.385).
    const bezelW = 1760 // FILM_W + 0.04 bezel reveal
    const bezelH = 1019 // FILM_H + 0.04
    const bezelCy = 646 // FILM_Y
    ctx.save()
    ctx.shadowColor = 'rgba(59, 58, 72, 0.25)'
    ctx.shadowBlur = 24
    ctx.fillStyle = XR_UI.screen
    ctx.beginPath()
    ctx.roundRect(w / 2 - bezelW / 2, bezelCy - bezelH / 2, bezelW, bezelH, 48)
    ctx.fill()
    ctx.restore()

    // Dock groove behind the play/scrub/scale controls.
    const dockW = 1880
    const dockH = 152
    const dockCy = 1354 // DOCK_Y
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)'
    ctx.beginPath()
    ctx.roundRect(w / 2 - dockW / 2, dockCy - dockH / 2, dockW, dockH, dockH / 2)
    ctx.fill()
  })
}

/** PiP-style badge: glass pill chip, ink Baloo label. Optional REC dot with glow. */
export function makeBadgeTexture(
  label: string,
  opts: { recDot?: boolean } = {}
): THREE.CanvasTexture {
  return makeCanvasTexture(720, 128, (ctx, w, h) => {
    const pad = 14
    ctx.clearRect(0, 0, w, h)
    ctx.save()
    ctx.shadowColor = XR_UI.shadow
    ctx.shadowBlur = 12
    ctx.shadowOffsetY = 4
    ctx.fillStyle = XR_UI.glass
    ctx.beginPath()
    ctx.roundRect(pad, pad, w - pad * 2, h - pad * 2, (h - pad * 2) / 2)
    ctx.fill()
    ctx.restore()
    ctx.strokeStyle = XR_UI.glassStroke
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.roundRect(pad + 1, pad + 1, w - pad * 2 - 2, h - pad * 2 - 2, (h - pad * 2) / 2)
    ctx.stroke()
    ctx.fillStyle = XR_UI.ink
    ctx.font = SANS
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, 44, h / 2 + 4)
    if (opts.recDot) {
      ctx.save()
      ctx.shadowColor = XR_UI.rec
      ctx.shadowBlur = 18
      ctx.fillStyle = XR_UI.rec
      ctx.beginPath()
      ctx.arc(w - 60, h / 2, 20, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
  })
}
