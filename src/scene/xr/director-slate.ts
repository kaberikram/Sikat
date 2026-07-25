/**
 * DIRECTOR_LINK slate under the grip viewfinder — the in-headset voice surface.
 *
 * A small state machine renders one calm glass card:
 *   idle      — "hold A · talk" hint
 *   listening — live mic level bars + interim transcript
 *   thinking  — soft pulsing dot while the crew works
 *   replying  — the director's actual words, first-class
 *   misheard  — gentle "didn't catch that" nudge
 *   offline   — link state
 *
 * One canvas + one CanvasTexture for the slate's lifetime; repaints draw in
 * place (no per-update canvas/GPU realloc — this sits on the hot voice path
 * inside the XR render loop).
 */
import * as THREE from 'three'
import { getLatestSuggestion } from '../../director/agent-runtime'
import { currentDemoHint, isDemoActive } from '../../director/demo-shoot'
import { setEditorLayer } from '../infrastructure'
import { getAimedObject } from './aim-picker'
import { currentCoachHint } from './xr-coach'
import { drawGlassCard, makeLiveCanvasTexture, XR_UI } from './xr-ui-chrome'

const SLATE_W = 0.14
const SLATE_H = 0.048
const TEX_W = 896
const TEX_H = 308

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
  /** Per-frame tick from the rig — drives pulse/level animation repaints. */
  update: (nowMs: number) => void
  dispose: () => void
}

const STATE_ACCENT: Record<SlateState, string> = {
  idle: XR_UI.mint,
  listening: XR_UI.sun,
  sending: XR_UI.blue,
  thinking: XR_UI.blue,
  replying: XR_UI.mint,
  misheard: XR_UI.pink,
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
  group.position.set(0, -0.055, 0.002)
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

  function paint(nowMs: number): void {
    lastPaint = nowMs
    live.repaint((ctx, w, h) => {
      const st = effectiveState()
      drawGlassCard(ctx, w, h, { pad: 18, radius: 44 })

      // Status row — small accent dot + quiet label, no heavy pill.
      const rowY = 64
      const accent = STATE_ACCENT[st]
      ctx.fillStyle = accent
      ctx.beginPath()
      if (st === 'thinking' || st === 'sending') {
        // Calm breathing dot.
        const r = 11 + Math.sin(pulsePhase) * 4
        ctx.arc(64, rowY, Math.max(r, 6), 0, Math.PI * 2)
      } else {
        ctx.arc(64, rowY, 11, 0, Math.PI * 2)
      }
      ctx.fill()

      ctx.fillStyle = XR_UI.inkSoft
      ctx.font = '700 30px "Baloo 2", ui-rounded, system-ui, sans-serif'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(STATE_LABEL[st], 94, rowY + 2)

      ctx.textAlign = 'right'
      ctx.font = '600 26px "Baloo 2", ui-rounded, system-ui, sans-serif'
      const hint =
        st === 'listening'
          ? 'RELEASE TO SEND'
          : st === 'thinking' || st === 'sending'
            ? ''
            : 'HOLD A · TALK'
      if (hint) ctx.fillText(hint, w - 56, rowY + 2)

      // Body — one open area, generous space; no inner well boxes.
      const bodyY = 108
      const bodyH = h - bodyY - 34
      const maxW = w - 128

      if (st === 'listening') {
        // Live level bars centered under the interim line — you can see it hear you.
        const text = interim.trim()
        ctx.fillStyle = text ? XR_UI.ink : XR_UI.inkSoft
        ctx.font = '600 34px "Baloo 2", ui-rounded, system-ui, sans-serif'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        const line = wrapLines(ctx, text || '…', maxW, 1)[0]
        ctx.fillText(line, 64, bodyY + 28)

        const barW = 10
        const gap = (maxW - LEVEL_BARS * barW) / (LEVEL_BARS - 1)
        const baseY = bodyY + bodyH - 12
        for (let i = 0; i < LEVEL_BARS; i++) {
          // Center-weighted bars driven by smoothed RMS, with per-bar shimmer.
          const centerBias = 1 - Math.abs(i - (LEVEL_BARS - 1) / 2) / (LEVEL_BARS / 2)
          const shimmer = 0.65 + 0.35 * Math.sin(pulsePhase * 2 + i * 1.7)
          const amp = Math.min(smoothedLevel * 6, 1) * centerBias * shimmer
          const bh = 6 + amp * 42
          ctx.fillStyle = amp > 0.08 ? XR_UI.sunDeep : 'rgba(122, 119, 134, 0.35)'
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
        // Idle priority: sticky notice > point lock-on > crew suggestion >
        // first-run coach > shot list > onboarding fallback.
        const aim = getAimedObject()
        const suggestion = getLatestSuggestion()
        const hint = bodyText ? null : currentDemoHint()
        line = notice
          || bodyText
          || (aim ? `▸ ${aim.name} — say “make this…”` : null)
          || (suggestion ? `💡 ${suggestion.text} — say “do it”` : null)
          || currentCoachHint(nowMs)
          || hint
          || 'say “crew, set the stage”'
        ghost = !bodyText && !notice
      }

      ctx.fillStyle = ghost ? XR_UI.inkSoft : XR_UI.ink
      ctx.font = '600 34px "Baloo 2", ui-rounded, system-ui, sans-serif'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      const rows = wrapLines(ctx, line, maxW, 3)
      const lineH = 44
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
        mat.opacity = 1
      }
      return
    }
    settled = false
    const e = 1 - (1 - Math.max(t, 0)) ** 3
    mesh.scale.setScalar(STATE_DIP_SCALE + (1 - STATE_DIP_SCALE) * e)
    mat.opacity = STATE_DIP_OPACITY + (1 - STATE_DIP_OPACITY) * e
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
      } else if ((st === 'replying' || st === 'misheard') && holdUntil) {
        if (now > holdUntil) {
          state = 'idle'
          bodyText = ''
          mishearBody = ''
          holdUntil = 0
          repaint(true)
        }
      } else if (st === 'idle') {
        // Repaint when the demo beat, aim lock, suggestion, or coach line changes.
        const aim = getAimedObject()
        const suggestion = getLatestSuggestion()
        const hint = `${isDemoActive() ? currentDemoHint() : ''}|${aim?.id ?? ''}|${suggestion?.suggestionId ?? ''}|${currentCoachHint(now) ?? ''}`
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
