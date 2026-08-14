/**
 * DIRECTOR_LINK card — the in-headset exception surface, and the frame the
 * viewfinder sits in.
 *
 * This used to be the system's voice: every acknowledgement, every reply, the
 * mic meter and the thinking dot all landed here. They now land in the world
 * (see `ambient-channel.ts`), and the card carries only what the world cannot
 * say — a blocked mic, a dropped link, a missing controller, the first-run
 * coach lines, the step-by-step of a running plan, and the crew's own words
 * when the scene didn't already answer.
 *
 * Layout follows the Figma `ai-thinking-state` node: a header row, an optional
 * body block, and the viewfinder's preview well, stacked with a fixed padding
 * and gap. The card's *height* is whatever those blocks add up to, so an idle
 * card is short rather than a tall card with a hole in it.
 *
 * The plane is sized for the tallest state and the card is drawn bottom-anchored
 * inside it, growing upward. That keeps the preview well — and therefore the
 * viewfinder mesh the rig parks on it — perfectly still while the chrome above
 * changes size. You aim with that image; it must not jump when you start
 * talking.
 *
 * The card itself is always up — it is the camcorder's chrome, not a caption,
 * and a screen surround that vanished between takes would leave the shot
 * floating. What the ambient policy still governs is the **body block**: in
 * ambient mode the states the world already answers get no words here, so an
 * untouched card is just a header and the shot.
 *
 * The preview well is *cut out* of the texture rather than painted. The screen
 * mesh is opaque and this card is transparent, and three.js draws every opaque
 * object before any transparent one — so no `renderOrder` can put this card
 * behind the shot, and anything painted in the well lands on top of it.
 *
 * One canvas + one CanvasTexture for the card's lifetime; repaints draw in
 * place (no per-update canvas/GPU realloc), and an idle card repaints only when
 * the line it would show changes.
 */
import * as THREE from 'three'
import { currentDemoHint, isDemoActive } from '../../director/demo-shoot'
import { useEditorStore } from '../../store'
import { setEditorLayer } from '../infrastructure'
import { currentCoachHint } from './xr-coach'
import { fitLine, wrapLines } from './text-wrap'
import { drawGlassPanel, drawProgressTrack, makeLiveCanvasTexture, XR_UI } from './xr-ui-chrome'

// ---- Figma metrics (node 49:4), in design units -------------------------------

const CARD_W_U = 264
const PAD_U = 14
const HEADER_H_U = 18
const BLOCK_GAP_U = 11
const CONTENT_W_U = CARD_W_U - PAD_U * 2
/**
 * The preview is 236×148 in the Figma (1.59:1), but the render target it shows
 * is 640×360 and that ratio is what actually gets recorded — so the well is
 * 16:9 and everything below it shifts up accordingly.
 */
const PREVIEW_H_U = (CONTENT_W_U * 9) / 16
const BUBBLE_PAD_U = 10
const BUBBLE_LINE_U = 16
/**
 * Processing block at one title line: pad + title + track + caption.
 * A second wrapped title line adds BUBBLE_LINE_U; see MAX_BODY_H_U.
 */
const PROCESSING_H_U = 68
/** Live level meter, tucked under the interim text while holding A. */
const BARS_H_U = 12
/** Transparent margin around the card so its soft shadow isn't clipped. */
const BLEED_U = 8

/**
 * Tallest body block, and therefore the card's maximum height. A three-line
 * bubble is 68 (10 + 3×16 + 10). A progress block with a two-line crew say
 * is 84. The plane is sized for that so the viewfinder well never moves.
 */
const MAX_BODY_H_U = PROCESSING_H_U + BUBBLE_LINE_U
const CARD_MAX_H_U =
  PAD_U + HEADER_H_U + BLOCK_GAP_U + MAX_BODY_H_U + BLOCK_GAP_U + PREVIEW_H_U + PAD_U

// ---- world size, in metres ----------------------------------------------------

/** Visible card width. The plane is wider by the bleed on each side. */
const CARD_W = 0.27
const M_PER_U = CARD_W / CARD_W_U

/** Plane size — card plus transparent bleed. */
export const SLATE_W = (CARD_W_U + BLEED_U * 2) * M_PER_U
export const SLATE_H = (CARD_MAX_H_U + BLEED_U * 2) * M_PER_U

/** Preview well size — what the rig makes the viewfinder mesh. */
export const PREVIEW_W = CONTENT_W_U * M_PER_U
export const PREVIEW_H = PREVIEW_H_U * M_PER_U
/**
 * Preview centre relative to the plane's centre. The bleed is symmetric so it
 * cancels; this is purely how far the well sits below the middle of the card.
 */
export const PREVIEW_Y = (PAD_U + PREVIEW_H_U / 2 - CARD_MAX_H_U / 2) * M_PER_U

// ---- canvas, at 4px per design unit -------------------------------------------

const PX = 4
const TEX_W = (CARD_W_U + BLEED_U * 2) * PX
const TEX_H = (CARD_MAX_H_U + BLEED_U * 2) * PX
const PAD = PAD_U * PX
const HEADER_H = HEADER_H_U * PX
const BLOCK_GAP = BLOCK_GAP_U * PX
const CONTENT_W = CONTENT_W_U * PX
const PREVIEW_H_PX = PREVIEW_H_U * PX
const BUBBLE_PAD = BUBBLE_PAD_U * PX
const BUBBLE_LINE = BUBBLE_LINE_U * PX
const PROCESSING_H = PROCESSING_H_U * PX
const BARS_H = BARS_H_U * PX
const BLEED = BLEED_U * PX
const CARD_W_PX = CARD_W_U * PX
const CONTENT_X = BLEED + PAD
/** Height of a card with no body block — header, gap, preview, padding. */
const CARD_BASE_H = PAD + HEADER_H + BLOCK_GAP + PREVIEW_H_PX + PAD

const CARD_RADIUS = 18 * PX
const BLOCK_RADIUS = 8 * PX

const FONT_LABEL = '700 52px "Nunito", ui-rounded, system-ui, sans-serif'
const FONT_HINT = '600 40px "Nunito", ui-rounded, system-ui, sans-serif'
const FONT_BODY = '600 48px "Nunito", ui-rounded, system-ui, sans-serif'
const FONT_CAPTION = '500 38px "JetBrains Mono", ui-monospace, monospace'

export type SlateState =
  | 'idle'
  | 'listening'
  | 'sending'
  | 'thinking'
  | 'replying'
  | 'misheard'
  | 'offline'

export interface SlateProgress {
  /** What the crew is doing — the plan's own line. */
  label: string
  /** The step underway, shown small beneath the track. */
  caption: string
  /** 0..1 when the plan's length is known, null while it's still being written. */
  ratio: number | null
}

export interface DirectorSlate {
  group: THREE.Group
  setListening: (on: boolean) => void
  setInterim: (text: string) => void
  setLastSent: (text: string) => void
  setThinking: (on: boolean) => void
  setReply: (text: string) => void
  /** `text` carries the crew's own words when the miss came from the server. */
  setMisheard: (text?: string) => void
  /** Released, tail still draining — keep the captured words on screen. */
  setSending: (text: string) => void
  setOffline: (on: boolean) => void
  /** Sticky guidance line (e.g. "pick up the right controller") — cleared explicitly. */
  setNotice: (text: string | null) => void
  setLevel: (level: number) => void
  /**
   * Step-by-step of a running plan. `ratio` null means the work is real but its
   * length isn't known yet — the track shimmers rather than claiming a fraction.
   * Null clears it.
   */
  setProgress: (progress: SlateProgress | null) => void
  /**
   * Ambient mode (the default in XR): fade out and stop repainting for every
   * state the world already carries. Turn it off to get the old always-on card.
   */
  setAmbient: (on: boolean) => void
  /** Per-frame tick from the rig — drives pulse/level animation repaints. */
  update: (nowMs: number) => void
  dispose: () => void
}

const STATE_ACCENT: Record<SlateState, string> = {
  idle: XR_UI.status,
  listening: XR_UI.accent,
  sending: XR_UI.accent,
  // Amber while executing, per the design's third state — a working set reads
  // differently at a glance from one that is only listening.
  thinking: XR_UI.sunDeep,
  replying: XR_UI.status,
  misheard: XR_UI.rec,
  offline: XR_UI.rec,
}

const STATE_LABEL: Record<SlateState, string> = {
  idle: 'Director',
  listening: 'Listening',
  sending: 'Heard',
  thinking: 'Executing',
  replying: 'Director',
  misheard: 'Director',
  offline: 'Offline',
}

const STATE_HINT: Record<SlateState, string> = {
  idle: 'Hold A to talk',
  listening: 'Release to send',
  sending: '',
  thinking: 'Working…',
  replying: 'Hold A to talk',
  misheard: 'Hold A to talk',
  offline: '',
}

const DEFAULT_MISHEARD = 'didn’t catch that — name an object or a move'

/** How long a reply stays up before easing back to idle. */
const REPLY_HOLD_MS = 6000
const MISHEARD_HOLD_MS = 3500
/**
 * Animated states repaint at ~24fps. At 12fps the breathing dot and the level
 * bars advanced in visible steps at arm's length — smoothness is about what's
 * in the frames, not just the rate. Still only 2 of 3 frames on a 72Hz headset;
 * if frametime regresses on device, this is the first knob to turn back.
 */
const ANIM_REPAINT_MS = 40
const LEVEL_BARS = 24

/**
 * State changes ease the card itself rather than cutting the texture: a quick
 * dip in opacity and scale, then a settle. The card is the surface you look at
 * most in the headset, and it was the only one that never moved.
 */
const STATE_SETTLE_MS = 190
/** How far the card recedes at the moment of the change. */
const STATE_DIP_SCALE = 0.965
const STATE_DIP_OPACITY = 0.55

/**
 * What sits between the header and the preview, if anything.
 *
 * `null` is the idle card the design shows: header, then the shot. Everything
 * else is either words or the progress of a running plan.
 */
type SlateBody =
  | { kind: 'text'; lines: string[]; ghost: boolean; bars: boolean }
  | { kind: 'progress'; progress: SlateProgress; titleLines: string[] }
  | null

/** Listening caps at two lines to leave room for the level meter; see BARS_H_U. */
function bodyLineCap(st: SlateState): number {
  return st === 'listening' ? 2 : 3
}

function bodyHeight(body: SlateBody): number {
  if (body === null) return 0
  if (body.kind === 'progress') {
    const extra = Math.max(0, body.titleLines.length - 1) * BUBBLE_LINE
    return PROCESSING_H + extra
  }
  return BUBBLE_PAD * 2 + body.lines.length * BUBBLE_LINE + (body.bars ? BARS_H : 0)
}

/** Inner width of the wash bubble, minus room for a trailing `42%`. */
function progressTitleMaxW(ctx: CanvasRenderingContext2D, progress: SlateProgress): number {
  const innerW = CONTENT_W - BUBBLE_PAD * 2
  if (progress.ratio === null) return innerW
  ctx.font = FONT_HINT
  const pctW = ctx.measureText(`${Math.round(progress.ratio * 100)}%`).width + 16
  ctx.font = FONT_BODY
  return Math.max(innerW - pctW, innerW * 0.55)
}

function drawHeader(
  ctx: CanvasRenderingContext2D,
  st: SlateState,
  top: number,
  pulsePhase: number
): void {
  const midY = top + HEADER_H / 2
  ctx.fillStyle = STATE_ACCENT[st]
  ctx.beginPath()
  if (st === 'thinking' || st === 'sending') {
    // Calm breathing dot — the one thing on the card that says "still going".
    const r = 14 + Math.sin(pulsePhase) * 4
    ctx.arc(CONTENT_X + 14, midY, Math.max(r, 7), 0, Math.PI * 2)
  } else {
    ctx.arc(CONTENT_X + 14, midY, 14, 0, Math.PI * 2)
  }
  ctx.fill()

  ctx.fillStyle = XR_UI.ink
  ctx.font = FONT_LABEL
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(STATE_LABEL[st], CONTENT_X + 52, midY + 2)

  const hint = STATE_HINT[st]
  if (hint) {
    ctx.fillStyle = XR_UI.faint
    ctx.font = FONT_HINT
    ctx.textAlign = 'right'
    ctx.fillText(hint, CONTENT_X + CONTENT_W, midY + 2)
  }
}

function drawTextBlock(
  ctx: CanvasRenderingContext2D,
  body: Extract<SlateBody, { kind: 'text' }>,
  top: number,
  height: number,
  smoothedLevel: number,
  pulsePhase: number
): void {
  ctx.fillStyle = XR_UI.wash
  ctx.beginPath()
  ctx.roundRect(CONTENT_X, top, CONTENT_W, height, BLOCK_RADIUS)
  ctx.fill()

  ctx.save()
  ctx.beginPath()
  ctx.roundRect(CONTENT_X, top, CONTENT_W, height, BLOCK_RADIUS)
  ctx.clip()

  ctx.fillStyle = body.ghost ? XR_UI.inkSoft : XR_UI.ink
  ctx.font = FONT_BODY
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  let y = top + BUBBLE_PAD + BUBBLE_LINE / 2
  for (const line of body.lines) {
    ctx.fillText(line, CONTENT_X + BUBBLE_PAD, y)
    y += BUBBLE_LINE
  }
  ctx.restore()

  if (!body.bars) return
  // You can see it hear you: centre-weighted bars off the smoothed RMS.
  const barsW = CONTENT_W - BUBBLE_PAD * 2
  const barW = 8
  const gap = (barsW - LEVEL_BARS * barW) / (LEVEL_BARS - 1)
  const baseY = top + height - BUBBLE_PAD
  for (let i = 0; i < LEVEL_BARS; i++) {
    const centerBias = 1 - Math.abs(i - (LEVEL_BARS - 1) / 2) / (LEVEL_BARS / 2)
    const shimmer = 0.65 + 0.35 * Math.sin(pulsePhase * 2 + i * 1.7)
    const amp = Math.min(smoothedLevel * 6, 1) * centerBias * shimmer
    const bh = 6 + amp * (BARS_H - 10)
    ctx.fillStyle = amp > 0.08 ? XR_UI.accent : 'rgba(169, 169, 179, 0.35)'
    ctx.beginPath()
    ctx.roundRect(CONTENT_X + BUBBLE_PAD + i * (barW + gap), baseY - bh, barW, bh, barW / 2)
    ctx.fill()
  }
}

function drawProgressBlock(
  ctx: CanvasRenderingContext2D,
  body: Extract<SlateBody, { kind: 'progress' }>,
  top: number,
  height: number,
  pulsePhase: number
): void {
  const { progress, titleLines } = body
  ctx.fillStyle = XR_UI.wash
  ctx.beginPath()
  ctx.roundRect(CONTENT_X, top, CONTENT_W, height, BLOCK_RADIUS)
  ctx.fill()

  const innerX = CONTENT_X + BUBBLE_PAD
  const innerW = CONTENT_W - BUBBLE_PAD * 2
  const extra = Math.max(0, titleLines.length - 1) * BUBBLE_LINE

  ctx.save()
  ctx.beginPath()
  ctx.roundRect(CONTENT_X, top, CONTENT_W, height, BLOCK_RADIUS)
  ctx.clip()

  ctx.fillStyle = XR_UI.ink
  ctx.font = FONT_BODY
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const titleY = top + 10 * PX + 8 * PX
  titleLines.forEach((line, i) => {
    ctx.fillText(line, innerX, titleY + i * BUBBLE_LINE)
  })

  if (progress.ratio !== null) {
    ctx.fillStyle = XR_UI.sunDeep
    ctx.font = FONT_HINT
    ctx.textAlign = 'right'
    ctx.fillText(`${Math.round(progress.ratio * 100)}%`, innerX + innerW, titleY)
  }

  ctx.restore()

  drawProgressTrack(ctx, innerX, top + 34 * PX + extra, innerW, 4 * PX, progress.ratio, pulsePhase)

  if (progress.caption) {
    ctx.fillStyle = XR_UI.inkSoft
    ctx.font = FONT_CAPTION
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(fitLine(ctx, progress.caption, innerW), innerX, top + 52 * PX + extra)
  }
}

/**
 * Cut the viewfinder's window out of the card rather than painting a well on it.
 *
 * The screen mesh is opaque and this card is transparent, and three.js draws the
 * whole opaque list before the whole transparent list — `renderOrder` sorts only
 * *within* a list, so no ordering can put this card behind the screen. Painting
 * anything here, however faint, lands on top of the shot. Erasing to real
 * transparency is the one approach that doesn't depend on draw order at all.
 */
function cutPreviewWindow(ctx: CanvasRenderingContext2D, top: number): void {
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.beginPath()
  ctx.roundRect(CONTENT_X, top, CONTENT_W, PREVIEW_H_PX, BLOCK_RADIUS)
  ctx.fill()
  ctx.restore()

  // Hairline back over the cut so the window still reads as an inset well.
  ctx.strokeStyle = 'rgba(23, 23, 26, 0.10)'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.roundRect(CONTENT_X, top, CONTENT_W, PREVIEW_H_PX, BLOCK_RADIUS)
  ctx.stroke()
}

export function createDirectorSlate(parent: THREE.Object3D): DirectorSlate {
  // Placement is the rig's call — it owns the column the card sits in.
  const group = new THREE.Group()
  parent.add(group)

  let state: SlateState = 'idle'
  let interim = ''
  let bodyText = ''
  let mishearBody = ''
  let notice: string | null = null
  let offline = false
  let smoothedLevel = 0
  let lastPaint = 0
  let holdUntil = 0
  let pulsePhase = 0
  let lastHint: string | null = null
  /** Timestamp of the last state change — drives the re-form ease in update(). */
  let stateChangedAt = -Infinity
  let lastAnimatedState: SlateState | null = null
  /** True once the re-form ease has landed, so it stops writing every frame. */
  let settled = true
  /**
   * Ambient mode is the default in XR — the world answers, so the card holds
   * back the *body block* for anything the set already carries. It no longer
   * gates the card itself: the chrome around the shot is the camcorder, not a
   * caption, and it stays up.
   */
  let ambient = true
  /** Step-by-step of a running plan, when the crew is sending one. */
  let progress: SlateProgress | null = null

  const live = makeLiveCanvasTexture(TEX_W, TEX_H)
  // Depth-tested, so the controller/hand occluder in `camcorder-rig.ts` can put
  // your real hand in front of the card where they overlap. The set can clip it
  // in principle too, but the panel rides 12cm off the grip against a stage
  // ~1.9m away, so in practice it never gets the chance.
  const mat = new THREE.MeshBasicMaterial({
    map: live.texture,
    transparent: true,
    toneMapped: false,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(SLATE_W, SLATE_H), mat)
  mesh.renderOrder = 13
  group.add(mesh)
  setEditorLayer(group)

  function effectiveState(): SlateState {
    if (offline) return 'offline'
    return state
  }

  /**
   * What an idle card would show, or null when it genuinely has nothing to say.
   * Single source of truth for the idle body — everything the card might
   * volunteer unprompted goes through this ladder, so nothing can be hidden by
   * being left off a hand-listed subset somewhere else.
   */
  function idleLine(nowMs: number): string | null {
    const line =
      notice
      || bodyText
      || currentCoachHint(nowMs)
      || (isDemoActive() ? currentDemoHint() : null)
    if (line) return line
    // Way in for a director with nothing else on screen — including a returning
    // one, who gets no coach (already seen) and no shot list (no demo running)
    // and would otherwise face a dimmed room with no affordances at all. It
    // retires the moment there is a set to work on, so it never nags someone
    // who is clearly already going.
    if (useEditorStore.getState().objects.length === 0) return 'say “crew, set the stage”'
    return null
  }

  /**
   * The block between the header and the preview, if this state has one.
   *
   * Takes a measuring context because the line count decides the block's height,
   * and the height decides where the card's top edge lands.
   */
  function bodyFor(ctx: CanvasRenderingContext2D, st: SlateState, nowMs: number): SlateBody {
    if (st === 'thinking') {
      // "Something is happening" is the room's job — the stage ring says it
      // better than a word could, so in ambient mode a bare thinking state gets
      // no block at all. *Which* step, of how many, is not something a pulsing
      // ring can carry, so a plan that reports its steps earns one.
      if (progress) {
        ctx.font = FONT_BODY
        const titleLines = wrapLines(
          ctx,
          progress.label.trim() || 'working the take',
          progressTitleMaxW(ctx, progress),
          2
        )
        return { kind: 'progress', progress, titleLines }
      }
      if (ambient) return null
    }

    let line = ''
    let ghost = false
    if (st === 'listening') {
      line = interim.trim() || '…'
      ghost = !interim.trim()
    } else if (st === 'sending' || st === 'thinking') {
      // Only reachable for `thinking` with ambient off — the always-on card
      // that debugging and desktop-style use want.
      line = bodyText
      ghost = true
    } else if (st === 'misheard') {
      line = mishearBody || DEFAULT_MISHEARD
    } else if (st === 'replying') {
      line = bodyText
    } else {
      // Idle priority lives in idleLine so every caller agrees about whether
      // there is something to say.
      line = idleLine(nowMs) ?? ''
      ghost = !bodyText && !notice
    }

    const bars = st === 'listening'
    if (!line) return bars ? { kind: 'text', lines: [], ghost, bars } : null

    ctx.font = FONT_BODY
    const lines = wrapLines(ctx, line, CONTENT_W - BUBBLE_PAD * 2, bodyLineCap(st))
    return { kind: 'text', lines, ghost, bars }
  }

  function paint(nowMs: number): void {
    lastPaint = nowMs
    live.repaint((ctx, _w, h) => {
      const st = effectiveState()
      const body = bodyFor(ctx, st, nowMs)
      const bodyH = bodyHeight(body)
      const cardH = CARD_BASE_H + (body ? BLOCK_GAP + bodyH : 0)
      // Bottom-anchored: the card grows upward so the preview well — and the
      // viewfinder parked on it — never move between states.
      const cardTop = h - BLEED - cardH

      drawGlassPanel(ctx, BLEED, cardTop, CARD_W_PX, cardH, {
        // Opaque, unlike the design system's floating panels: this one is a
        // screen housing you look *at*, and the default 92% frost let the room
        // and every object behind it ghost through the card.
        fill: XR_UI.paper,
        radius: CARD_RADIUS,
        shadow: BLEED,
      })

      let y = cardTop + PAD
      drawHeader(ctx, st, y, pulsePhase)
      y += HEADER_H

      if (body) {
        y += BLOCK_GAP
        if (body.kind === 'progress') {
          drawProgressBlock(ctx, body, y, bodyH, pulsePhase)
        } else {
          drawTextBlock(ctx, body, y, bodyH, smoothedLevel, pulsePhase)
        }
        y += bodyH
      }

      y += BLOCK_GAP
      cutPreviewWindow(ctx, y)
    })
  }

  function repaint(force = false): void {
    const now = performance.now()
    if (!force && now - lastPaint < ANIM_REPAINT_MS) return
    paint(now)
  }

  /**
   * Ease the card back from its dip after a state change. Cheap — a scale and
   * an opacity on one mesh, no texture work — and a no-op once settled.
   */
  function applyStateSettle(now: number): void {
    const t = (now - stateChangedAt) / STATE_SETTLE_MS
    if (t >= 1) {
      // Land exactly once, then stop touching the mesh every frame.
      if (!settled) {
        settled = true
        mesh.scale.setScalar(1)
        mat.opacity = 1
      }
      return
    }
    settled = false
    const e = 1 - (1 - Math.max(t, 0)) ** 3
    mesh.scale.setScalar(STATE_DIP_SCALE + (1 - STATE_DIP_SCALE) * e)
    mat.opacity = STATE_DIP_OPACITY + (1 - STATE_DIP_OPACITY) * e
  }

  /**
   * Drop held text once its hold has run out. Keyed on the hold itself rather
   * than on the state: `setLastSent` writes body text while leaving the state
   * `idle`, so a state-keyed expiry never fired for it and lines like
   * "take 3 saved to the timeline" stayed in the body block for the rest of
   * the session. Returns true when something was actually cleared.
   */
  function expireHold(now: number): boolean {
    if (!holdUntil || now <= holdUntil) return false
    state = 'idle'
    bodyText = ''
    mishearBody = ''
    holdUntil = 0
    return true
  }

  return {
    group,
    setListening: (on) => {
      if (on) {
        state = 'listening'
        interim = ''
      } else if (state === 'listening') {
        state = 'idle'
        interim = ''
      }
      repaint(true)
    },
    setInterim: (text) => {
      interim = text
      if (state === 'listening') repaint()
    },
    setLastSent: (text) => {
      // Back-compat surface: echo of the sent command / short status lines.
      bodyText = text
      if (state === 'listening') state = 'idle'
      holdUntil = performance.now() + REPLY_HOLD_MS
      repaint(true)
    },
    setSending: (text) => {
      // Release lands here immediately — the words you just said stay up while
      // the engine's tail drains, instead of the slate going blank.
      state = 'sending'
      bodyText = text
      interim = ''
      repaint(true)
    },
    setThinking: (on) => {
      if (on) {
        state = 'thinking'
      } else if (state === 'thinking' || state === 'sending') {
        state = 'idle'
        // The plan is over; its step count must not survive into the next one.
        progress = null
      }
      repaint(true)
    },
    setProgress: (next) => {
      progress = next
      repaint(true)
    },
    setReply: (text) => {
      state = 'replying'
      bodyText = text
      holdUntil = performance.now() + REPLY_HOLD_MS
      repaint(true)
    },
    setMisheard: (text) => {
      state = 'misheard'
      mishearBody = text?.trim() ?? ''
      bodyText = ''
      holdUntil = performance.now() + MISHEARD_HOLD_MS
      repaint(true)
    },
    setOffline: (on) => {
      offline = on
      repaint(true)
    },
    setNotice: (text) => {
      if (text === notice) return
      notice = text
      repaint(true)
    },
    setLevel: (next) => {
      // Fast attack, slow release — bars feel alive without flicker.
      smoothedLevel = next > smoothedLevel ? next : smoothedLevel * 0.85 + next * 0.15
    },
    setAmbient: (on) => {
      if (on === ambient) return
      ambient = on
      repaint(true)
    },
    update: () => {
      const now = performance.now()
      const st = effectiveState()

      // Re-form on every state change: the card recedes a hair and settles back,
      // so listening → sending → replying reads as one surface changing its mind
      // rather than three textures swapped in place.
      if (st !== lastAnimatedState) {
        lastAnimatedState = st
        stateChangedAt = now
      }
      applyStateSettle(now)

      if (st === 'thinking' || st === 'listening' || st === 'sending') {
        // Phase advances on wall time so the pulse rate doesn't ride the
        // repaint cadence.
        pulsePhase = (now / 1000) * 3
        repaint()
      } else if (expireHold(now)) {
        repaint(true)
      } else if (st === 'idle') {
        // Repaint when the line an idle card would show changes.
        const hint = idleLine(now) ?? ''
        if (hint !== lastHint) {
          lastHint = hint
          repaint(true)
        }
      }
    },
    dispose: () => {
      group.removeFromParent()
      mesh.geometry.dispose()
      live.dispose()
      mat.dispose()
    },
  }
}
