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
import { currentDemoHint, isDemoActive } from '../../director/demo-shoot'
import { setEditorLayer } from '../infrastructure'
import { getAimedObject } from './aim-picker'
import { drawGlassCard, makeLiveCanvasTexture, XR_UI } from './xr-ui-chrome'

const SLATE_W = 0.14
const SLATE_H = 0.048
const TEX_W = 896
const TEX_H = 308

export type SlateState = 'idle' | 'listening' | 'thinking' | 'replying' | 'misheard' | 'offline'

export interface DirectorSlate {
  group: THREE.Group
  setListening: (on: boolean) => void
  setInterim: (text: string) => void
  setLastSent: (text: string) => void
  setThinking: (on: boolean) => void
  setReply: (text: string) => void
  setMisheard: () => void
  setOffline: (on: boolean) => void
  setLevel: (level: number) => void
  /** Per-frame tick from the rig — drives pulse/level animation repaints. */
  update: (nowMs: number) => void
  dispose: () => void
}

const STATE_ACCENT: Record<SlateState, string> = {
  idle: XR_UI.mint,
  listening: XR_UI.sun,
  thinking: XR_UI.blue,
  replying: XR_UI.mint,
  misheard: XR_UI.pink,
  offline: XR_UI.rec,
}

const STATE_LABEL: Record<SlateState, string> = {
  idle: 'DIRECTOR',
  listening: 'LISTENING',
  thinking: 'THINKING',
  replying: 'DIRECTOR',
  misheard: 'DIRECTOR',
  offline: 'OFFLINE',
}

/** How long a reply stays up before easing back to idle. */
const REPLY_HOLD_MS = 6000
const MISHEARD_HOLD_MS = 3500
/** Animated states repaint at ~12fps — enough for a calm pulse, cheap on Quest. */
const ANIM_REPAINT_MS = 80
const LEVEL_BARS = 24

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
  let offline = false
  let smoothedLevel = 0
  let lastPaint = 0
  let holdUntil = 0
  let pulsePhase = 0
  let lastHint: string | null = null

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
      if (st === 'thinking') {
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
        st === 'listening' ? 'RELEASE TO SEND' : st === 'thinking' ? '' : 'HOLD A · TALK'
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
      if (st === 'thinking') {
        line = bodyText || ''
        ghost = true
      } else if (st === 'misheard') {
        line = 'didn’t catch that — name an object or a move'
        ghost = false
      } else if (st === 'replying') {
        line = bodyText
      } else {
        // Idle: point lock-on wins, then the SET DAY shot list, then onboarding.
        const aim = getAimedObject()
        const hint = bodyText ? null : currentDemoHint()
        line = bodyText
          || (aim ? `▸ ${aim.name} — say “make this…”` : null)
          || hint
          || 'say “crew, set the stage”'
        ghost = !bodyText
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
    setThinking: (on) => {
      if (on) {
        state = 'thinking'
        pulsePhase = 0
      } else if (state === 'thinking') {
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
    setMisheard: () => {
      state = 'misheard'
      holdUntil = performance.now() + MISHEARD_HOLD_MS
      repaint(true)
    },
    setOffline: (on) => {
      offline = on
      repaint(true)
    },
    setLevel: (next) => {
      // Fast attack, slow release — bars feel alive without flicker.
      smoothedLevel = next > smoothedLevel ? next : smoothedLevel * 0.85 + next * 0.15
    },
    update: () => {
      const st = effectiveState()
      if (st === 'thinking' || st === 'listening') {
        pulsePhase += 0.12
        repaint()
      } else if ((st === 'replying' || st === 'misheard') && holdUntil) {
        if (performance.now() > holdUntil) {
          state = 'idle'
          bodyText = ''
          holdUntil = 0
          repaint(true)
        }
      } else if (st === 'idle') {
        // Repaint when the demo beat advances or the aim lock changes.
        const aim = getAimedObject()
        const hint = `${isDemoActive() ? currentDemoHint() : ''}|${aim?.id ?? ''}`
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
