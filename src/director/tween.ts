/**
 * Minimal tween engine for agent transitions.
 *
 * Tweens write STORE base values (via the setter closure) — never Three.js
 * objects — so Scene.tsx's per-frame re-apply and gizmo-drag guards keep
 * working unchanged. One shared rAF loop; a new tween on the same key cancels
 * the previous one. Pauses (shifts start times) while the editor is exporting.
 */
import { useEditorStore } from '../store'
import type { Easing } from './protocol'

const EASING: Record<Easing, (t: number) => number> = {
  linear: (t) => t,
  easeIn: (t) => t * t * t,
  easeOut: (t) => 1 - (1 - t) ** 3,
  easeInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
}

interface ActiveTween {
  from: number[]
  to: number[]
  start: number
  durationMs: number
  ease: (t: number) => number
  set: (values: number[]) => void
}

const active = new Map<string, ActiveTween>()
let rafId: number | null = null
let lastNow = 0

function tick(now: number) {
  const delta = now - lastNow
  lastNow = now
  if (useEditorStore.getState().isExporting) {
    // hold every tween in place while the exporter owns the scene
    for (const tween of active.values()) tween.start += delta
  } else {
    for (const [key, tween] of active) {
      const alpha = Math.min(1, (now - tween.start) / tween.durationMs)
      const eased = tween.ease(alpha)
      tween.set(tween.from.map((f, i) => f + (tween.to[i] - f) * eased))
      if (alpha >= 1) active.delete(key)
    }
  }
  if (active.size > 0) rafId = requestAnimationFrame(tick)
  else rafId = null
}

export interface TweenOptions {
  /** Cancellation key, e.g. `${objectId}:position`. */
  key: string
  from: number[]
  to: number[]
  durationSec: number
  easing: Easing
  set: (values: number[]) => void
}

export function startTween({ key, from, to, durationSec, easing, set }: TweenOptions) {
  active.set(key, {
    from,
    to,
    start: performance.now(),
    durationMs: Math.max(1, durationSec * 1000),
    ease: EASING[easing] ?? EASING.easeInOut,
    set,
  })
  if (rafId === null) {
    lastNow = performance.now()
    rafId = requestAnimationFrame(tick)
  }
}

export function cancelTweensFor(prefix: string) {
  for (const key of active.keys()) {
    if (key.startsWith(prefix)) active.delete(key)
  }
}
