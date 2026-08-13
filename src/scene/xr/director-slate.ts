/**
 * DIRECTOR_LINK slate under the grip viewfinder — the in-headset exception
 * surface.
 *
 * This used to be the system's voice: every acknowledgement, every reply, the
 * mic meter and the thinking dot all landed here. They now land in the world
 * (see `ambient-channel.ts`), and the slate carries only what the world cannot
 * say — a blocked mic, a dropped link, a missing controller, the first-run
 * coach lines, and the crew's own words when the scene didn't already answer.
 *
 * In ambient mode the card fades to nothing and **stops repainting entirely**
 * for the states the world covers (thinking). Listening and sending stay on
 * this card so hold-A live STT is readable at arm's length. Repainting a
 * 896×480 canvas every 40ms sat on the XR frame path — idle still skips it.
 *
 * One canvas + one CanvasTexture for the slate's lifetime; repaints draw in
 * place (no per-update canvas/GPU realloc).
 */
import * as THREE from 'three'
import { currentDemoHint, isDemoActive } from '../../director/demo-shoot'
import { useEditorStore } from '../../store'
import { setEditorLayer } from '../infrastructure'
import { currentCoachHint } from './xr-coach'
import { drawGlassCard, makeLiveCanvasTexture, XR_UI } from './xr-ui-chrome'

const SLATE_W = 0.3
const SLATE_H = 0.11
const TEX_W = 896
const TEX_H = 480

export type SlateState =
  | 'idle'
  | 'listening'
  | 'sending'
  | 'thinking'
  | 'replying'
  | 'misheard'
  | 'offline'

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
  thinking: XR_UI.accent,
  replying: XR_UI.status,
  misheard: XR_UI.rec,
  offline: XR_UI.rec,
}

const STATE_LABEL: Record<SlateState, string> = {
  idle: 'DIRECTOR',
  listening: 'LISTENING',
  sending: 'HEARD',
  thinking: 'THINKING',
  replying: 'DIRECTOR',
  misheard: 'DIRECTOR',
  offline: 'OFFLINE',
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
 * dip in opacity and scale, then a settle. The slate is the surface you look at
 * most in the headset, and it was the only one that never moved.
 */
const STATE_SETTLE_MS = 190
/** How far the card recedes at the moment of the change. */
const STATE_DIP_SCALE = 0.965
const STATE_DIP_OPACITY = 0.55
/** Fade rate in/out of ambient hiding — slower out than in, so it never snaps away. */
const VISIBILITY_DAMP_IN = 10
const VISIBILITY_DAMP_OUT = 5

function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  maxLines: number
): string[] {
  const words = text.split(/\s+/)
  const rows: string[] = []
  let row = ''
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
  if (rows.length > maxLines) {
    const cut = rows.slice(0, maxLines)
    cut[maxLines - 1] = `${cut[maxLines - 1].replace(/[.…,]?$/, '')}…`
    return cut
  }
  return rows
}

export function createDirectorSlate(parent: THREE.Object3D): DirectorSlate {
  const group = new THREE.Group()
  group.position.set(0, -0.09, 0.002)
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
  /** Ambient mode is the default in XR — the world answers, this card doesn't. */
  let ambient = true
  /**
   * Eased 0..1 presence of the card itself, independent of the state settle.
   * Starts hidden so the card fades *in* when it has something to say, rather
   * than flashing on at session start and easing back out.
   */
  let visibility = 0
  let lastFrameAt = 0

  const live = makeLiveCanvasTexture(TEX_W, TEX_H)
  const mat = new THREE.MeshBasicMaterial({
    map: live.texture,
    transparent: true,
    toneMapped: false,
    depthTest: false,
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
   * Does the world already answer this? Anything that reaches `replying`,
   * `misheard` or `offline` got here because the ambient channel decided words
   * were needed, so those always show. Listening/sending stay on this card
   * (live STT while holding A). Thinking is still the room's job. Idle only
   * hides when it has nothing sticky to say.
   */
  function worldCarries(st: SlateState, nowMs: number): boolean {
    if (!ambient) return false
    if (
      st === 'offline' ||
      st === 'replying' ||
      st === 'misheard' ||
      st === 'listening' ||
      st === 'sending'
    ) return false
    if (st === 'thinking') return true
    // The idle ladder decides what an idle card would say; if it would say
    // anything at all, the card has to be on screen to say it. Checking a
    // hand-listed subset here is how the SET DAY shot list went invisible in
    // XR: the hint was in the ladder but not in this gate, so the card faded
    // out and stopped repainting, and the cue lines were never shown.
    return idleLine(nowMs) === null
  }

  /**
   * What an idle card would show, or null when it genuinely has nothing to say.
   * Single source of truth for both the visibility gate and the paint.
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

  function paint(nowMs: number): void {
    lastPaint = nowMs
    live.repaint((ctx, w, h) => {
      const st = effectiveState()
      drawGlassCard(ctx, w, h, { pad: 18, radius: 44 })

      // Status row — small accent dot + quiet label, no heavy pill.
      const rowY = 72
      const accent = STATE_ACCENT[st]
      ctx.fillStyle = accent
      ctx.beginPath()
      if (st === 'thinking' || st === 'sending') {
        // Calm breathing dot.
        const r = 16 + Math.sin(pulsePhase) * 5
        ctx.arc(64, rowY, Math.max(r, 8), 0, Math.PI * 2)
      } else {
        ctx.arc(64, rowY, 16, 0, Math.PI * 2)
      }
      ctx.fill()

      ctx.fillStyle = XR_UI.inkSoft
      ctx.font = '700 48px "Nunito", ui-rounded, system-ui, sans-serif'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(STATE_LABEL[st], 100, rowY + 2)

      ctx.textAlign = 'right'
      ctx.font = '600 40px "Nunito", ui-rounded, system-ui, sans-serif'
      const hint =
        st === 'listening'
          ? 'RELEASE TO SEND'
          : st === 'thinking' || st === 'sending'
            ? ''
            : 'HOLD A · TALK'
      if (hint) ctx.fillText(hint, w - 56, rowY + 2)

      // Body — one open area, generous space; no inner well boxes.
      const bodyY = 130
      const bodyH = h - bodyY - 34
      const maxW = w - 128
      const bodyFont = '600 56px "Nunito", ui-rounded, system-ui, sans-serif'
      const lineH = 68

      if (st === 'listening') {
        // Live level bars under the wrapping interim — you can see it hear you.
        const text = interim.trim()
        ctx.fillStyle = text ? XR_UI.ink : XR_UI.inkSoft
        ctx.font = bodyFont
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        const rows = wrapLines(ctx, text || '…', maxW, 3)
        let y = bodyY + 32
        for (const row of rows) {
          ctx.fillText(row, 64, y)
          y += lineH
        }

        const barW = 10
        const gap = (maxW - LEVEL_BARS * barW) / (LEVEL_BARS - 1)
        const baseY = bodyY + bodyH - 12
        for (let i = 0; i < LEVEL_BARS; i++) {
          // Center-weighted bars driven by smoothed RMS, with per-bar shimmer.
          const centerBias = 1 - Math.abs(i - (LEVEL_BARS - 1) / 2) / (LEVEL_BARS / 2)
          const shimmer = 0.65 + 0.35 * Math.sin(pulsePhase * 2 + i * 1.7)
          const amp = Math.min(smoothedLevel * 6, 1) * centerBias * shimmer
          const bh = 8 + amp * 48
          ctx.fillStyle = amp > 0.08 ? XR_UI.accent : 'rgba(169, 169, 179, 0.35)'
          ctx.beginPath()
          ctx.roundRect(64 + i * (barW + gap), baseY - bh, barW, bh, barW / 2)
          ctx.fill()
        }
        return
      }

      let line = ''
      let ghost = false
      if (st === 'sending' || st === 'thinking') {
        line = bodyText || ''
        ghost = true
      } else if (st === 'misheard') {
        line = mishearBody || DEFAULT_MISHEARD
        ghost = false
      } else if (st === 'replying') {
        line = bodyText
      } else {
        // Idle priority lives in idleLine so the visibility gate and the paint
        // can never disagree about whether there is something to say.
        line = idleLine(nowMs) ?? ''
        ghost = !bodyText && !notice
      }

      ctx.fillStyle = ghost ? XR_UI.inkSoft : XR_UI.ink
      ctx.font = bodyFont
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      const rows = wrapLines(ctx, line, maxW, 3)
      let y = bodyY + bodyH / 2 - ((rows.length - 1) * lineH) / 2
      for (const row of rows) {
        ctx.fillText(row, 64, y)
        y += lineH
      }
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
      }
      mat.opacity = visibility
      return
    }
    settled = false
    const e = 1 - (1 - Math.max(t, 0)) ** 3
    mesh.scale.setScalar(STATE_DIP_SCALE + (1 - STATE_DIP_SCALE) * e)
    mat.opacity = (STATE_DIP_OPACITY + (1 - STATE_DIP_OPACITY) * e) * visibility
  }

  /**
   * Drop held text once its hold has run out. Keyed on the hold itself rather
   * than on the state: `setLastSent` writes body text while leaving the state
   * `idle`, so a state-keyed expiry never fired for it and lines like
   * "take 3 saved to the timeline" stayed on the card for the rest of the
   * session — pinning it visible, since non-empty body text also blocks the
   * ambient fade. Returns true when something was actually cleared.
   */
  function expireHold(now: number): boolean {
    if (!holdUntil || now <= holdUntil) return false
    state = 'idle'
    bodyText = ''
    mishearBody = ''
    holdUntil = 0
    return true
  }

  /** Ease the card's presence toward hidden/shown; returns true while it's on screen. */
  function applyVisibility(now: number): boolean {
    const delta = lastFrameAt ? Math.min((now - lastFrameAt) / 1000, 0.1) : 0
    lastFrameAt = now
    const want = worldCarries(effectiveState(), now) ? 0 : 1
    const rate = want > visibility ? VISIBILITY_DAMP_IN : VISIBILITY_DAMP_OUT
    visibility += (want - visibility) * Math.min(1, delta * rate)
    if (visibility < 0.004) visibility = 0
    mesh.visible = visibility > 0
    return mesh.visible
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
      }
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
      const onScreen = applyVisibility(now)
      applyStateSettle(now)

      // Fully faded out — no canvas work, no texture upload. This is the whole
      // point of ambient mode on the XR frame path.
      if (!onScreen) {
        // Held text still has to expire off-screen, or it would be sitting
        // there waiting the next time the card comes back.
        expireHold(now)
        return
      }

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
