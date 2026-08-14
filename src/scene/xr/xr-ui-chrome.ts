/**
 * Figma UI ELEMENTS tokens baked for XR meshes (Three.js can't use CSS).
 * Mirrors src/index.css: --color-ink / --color-accent / --shadow-soft.
 * Panels are visionOS-style faux frost: translucent rounded cards with a
 * painted soft shadow (no real backdrop blur — not worth it in XR).
 */
import * as THREE from 'three'

export const XR_UI = {
  ink: '#17171a',
  inkSoft: '#6b6b75',
  faint: '#a9a9b3',
  paper: '#ffffff',
  glass: 'rgba(255, 255, 255, 0.92)',
  glassStroke: 'rgba(255, 255, 255, 0.85)',
  chip: '#f1f1f4',
  wash: '#f5f5f8',
  accent: '#2c6bf5',
  status: '#30d158',
  // Agent identity — not chrome.
  pink: '#FFB1CE',
  pinkDeep: '#F27BAC',
  blue: '#2c6bf5',
  blueDeep: '#1f54c9',
  mint: '#B9EBD3',
  mintDeep: '#57CFA0',
  sun: '#FFE092',
  sunDeep: '#FFC43D',
  rec: '#FF6B7E',
  screen: '#17171a',
  shadow: 'rgba(10, 10, 23, 0.18)',
} as const

const SANS = '600 44px "Nunito", ui-rounded, system-ui, sans-serif'
const SANS_LG = '700 56px "Nunito", ui-rounded, system-ui, sans-serif'
export const XR_FONT_SANS = SANS
export const XR_FONT_SANS_LG = SANS_LG
export const XR_FONT_MONO = 'bold 36px "JetBrains Mono", ui-monospace, monospace'

const FONT_PROBE = '700 56px "Nunito"'

/** Kick off Nunito loading before any XR canvas rasterizes — call at app boot. */
export function preloadXrUiFonts(): void {
  if (typeof document === 'undefined' || !('fonts' in document)) return
  void document.fonts.load('600 44px "Nunito"')
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
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.anisotropy = 8
  tex.needsUpdate = true

  // Labels painted before Nunito arrives rasterize the fallback font —
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
/**
 * The frosted panel itself, at an arbitrary rect and without clearing.
 *
 * Split out of `drawGlassCard` for the director card, which draws a panel whose
 * height changes with what it has to say inside a canvas sized for the tallest
 * state — so it needs to place the panel rather than fill the bitmap.
 */
export function drawGlassPanel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: { fill?: string; radius?: number; shadow?: number } = {}
): void {
  const radius = opts.radius ?? 64
  const fill = opts.fill ?? XR_UI.glass
  const shadow = opts.shadow ?? 48

  ctx.save()
  ctx.shadowColor = XR_UI.shadow
  ctx.shadowBlur = shadow * 0.8
  ctx.shadowOffsetY = shadow * 0.3
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, radius)
  ctx.fill()
  ctx.restore()

  ctx.strokeStyle = XR_UI.glassStroke
  ctx.lineWidth = 5
  ctx.beginPath()
  ctx.roundRect(x + 2.5, y + 2.5, w - 5, h - 5, Math.max(radius - 2.5, 0))
  ctx.stroke()

  // Top-edge highlight
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, radius)
  ctx.clip()
  const hl = ctx.createLinearGradient(0, y, 0, y + h * 0.28)
  hl.addColorStop(0, 'rgba(255, 255, 255, 0.55)')
  hl.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = hl
  ctx.fillRect(x, y, w, h * 0.28)
  ctx.restore()
}

export function drawGlassCard(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  opts: { fill?: string; radius?: number; pad?: number } = {}
): void {
  const pad = opts.pad ?? 48
  ctx.clearRect(0, 0, w, h)
  drawGlassPanel(ctx, pad, pad, w - pad * 2, h - pad * 2, {
    fill: opts.fill,
    radius: opts.radius,
    shadow: pad,
  })
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
  ctx.strokeStyle = XR_UI.glassStroke
  ctx.lineWidth = 5
  ctx.beginPath()
  ctx.roundRect(x + 2.5, y + 2.5, w - 5, h - 5, Math.max(r - 2.5, 0))
  ctx.stroke()
  if (opts.hover) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.22)'
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, r)
    ctx.fill()
  }
}

/**
 * Progress track for the director card's executing block.
 *
 * `ratio` null means the work is real but its length isn't known yet — a plan
 * that is still being written has no step count. That draws a travelling sliver
 * rather than a filled bar, because a bar implies a fraction and we would be
 * inventing the denominator.
 */
export function drawProgressTrack(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  ratio: number | null,
  phase: number
): void {
  const r = h / 2
  ctx.fillStyle = XR_UI.chip
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
  ctx.fill()

  ctx.fillStyle = XR_UI.accent
  ctx.beginPath()
  if (ratio === null) {
    const sliverW = w * 0.28
    // Ping-pong so the sliver never jumps back to the start.
    const travel = (Math.sin(phase * 0.9) + 1) / 2
    ctx.roundRect(x + travel * (w - sliverW), y, sliverW, h, r)
  } else {
    ctx.roundRect(x, y, Math.max(h, w * Math.min(1, Math.max(0, ratio))), h, r)
  }
  ctx.fill()
}

/** Transport / action pill button. Default: wash chip with ink label. */
export function makeButtonTexture(
  label: string,
  opts: { bg?: string; fg?: string; w?: number; h?: number; hover?: boolean } = {}
): THREE.CanvasTexture {
  const w = opts.w ?? 576
  const h = opts.h ?? 192
  const pad = 28
  const bg = opts.bg ?? XR_UI.chip
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
    ctx.fillStyle = hover ? XR_UI.wash : XR_UI.chip
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

/** Scale handle — accent disk with a white corner arrow. */
export function makeScaleHandleTexture(): THREE.CanvasTexture {
  return makeCanvasTexture(256, 256, (ctx, w, h) => {
    const pad = 28
    const r = (Math.min(w, h) - pad * 2) / 2
    ctx.clearRect(0, 0, w, h)
    ctx.save()
    ctx.shadowColor = XR_UI.shadow
    ctx.shadowBlur = 20
    ctx.shadowOffsetY = 8
    ctx.fillStyle = XR_UI.accent
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
    ctx.fillStyle = 'rgba(23, 23, 26, 0.1)'
    ctx.beginPath()
    ctx.roundRect(pad, pad, w - pad * 2, h - pad * 2, (h - pad * 2) / 2)
    ctx.fill()
  })
}

/** Playhead — round white thumb with an accent ring. */
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
    ctx.strokeStyle = XR_UI.accent
    ctx.lineWidth = 12
    ctx.beginPath()
    ctx.arc(w / 2, h / 2, r - 6, 0, Math.PI * 2)
    ctx.stroke()
  })
}

/** Title chip — wash pill with ink Nunito label. */
export function makeTitleTexture(
  label: string,
  opts: { w?: number; h?: number } = {}
): THREE.CanvasTexture {
  const w = opts.w ?? 840
  const h = opts.h ?? 144
  return makeCanvasTexture(w, h, (ctx, cw, ch) => {
    ctx.clearRect(0, 0, cw, ch)
    const pad = 20
    drawPill(ctx, pad, pad, cw - pad * 2, ch - pad * 2, XR_UI.chip, { pad })
    ctx.fillStyle = XR_UI.ink
    ctx.font = SANS_LG
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, cw / 2, ch / 2 + 4)
  })
}

/** PiP-style badge: glass pill chip, ink Nunito label. Optional REC dot with glow. */
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
