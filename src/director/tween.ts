/**
 * Minimal tween engine for agent transitions.
 *
 * Tweens write STORE base values (via the setter closure) — never Three.js
 * objects — so Scene.tsx's per-frame re-apply and gizmo-drag guards keep
 * working unchanged. A new tween on the same key cancels the previous one.
 * Pauses (shifts start times) while the editor is exporting.
 *
 * **This engine has no clock of its own — `tickTweens()` must be called once
 * per rendered frame** (`src/scene/animate-loop.ts`). It used to drive itself
 * with `requestAnimationFrame`, which is suspended for the entire duration of
 * an immersive WebXR session: the frame callback has to come from the session,
 * which is what `renderer.setAnimationLoop` gives you. The visible symptom was
 * that a prop spawned in the headset stayed at the 1% scale its entrance pop
 * had just written, and only snapped to full size when the session ended and
 * the page's rAF resumed. Borrowing the renderer's clock is what makes this
 * correct in both modes, and keeps `director/` renderer-agnostic.
 */
import { useEditorStore } from '../store.ts'
import type { Easing } from './protocol'
import { getEaseFn } from '../easing.ts'

interface ActiveTween {
  from: number[]
  to: number[]
  start: number
  durationMs: number
  ease: (t: number) => number
  set: (values: number[]) => void
}

const active = new Map<string, ActiveTween>()
let lastNow = 0

/**
 * Advance every active tween. Call once per rendered frame.
 *
 * Reads the clock itself rather than taking the frame timestamp: `startTween`
 * stamps `start` from `performance.now()`, and an XR frame callback's timestamp
 * is not guaranteed to share that time origin. One clock in, one clock out.
 */
export function tickTweens(): void {
  if (active.size === 0) return
  const now = performance.now()
  // `lastNow` is primed by `startTween`, so this is a real interval on the very
  // first tick too. Inferring it from a sentinel instead let the first frame of
  // an export hold slip through unshifted, which is progress the pause was
  // supposed to prevent.
  const delta = now - lastNow
  lastNow = now
  if (useEditorStore.getState().isExporting) {
    // hold every tween in place while the exporter owns the scene
    for (const tween of active.values()) tween.start += delta
    return
  }
  for (const [key, tween] of active) {
    const alpha = Math.min(1, (now - tween.start) / tween.durationMs)
    const eased = tween.ease(alpha)
    tween.set(tween.from.map((f, i) => f + (tween.to[i] - f) * eased))
    if (alpha >= 1) active.delete(key)
  }
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
  // Prime the tick interval when the engine wakes from idle, so the first tick
  // measures a frame rather than however long nothing was running.
  if (active.size === 0) lastNow = performance.now()
  active.set(key, {
    from,
    to,
    start: performance.now(),
    durationMs: Math.max(1, durationSec * 1000),
    ease: getEaseFn(easing),
    set,
  })
}

/** Cancel an active tween and return the current interpolated value, if any. */
export function cancelTween(key: string): number[] | null {
  const tween = active.get(key)
  if (!tween) return null
  const now = performance.now()
  const alpha = Math.min(1, (now - tween.start) / tween.durationMs)
  const eased = tween.ease(alpha)
  const current = tween.from.map((f, i) => f + (tween.to[i] - f) * eased)
  tween.set(current)
  active.delete(key)
  return current
}

/** Retarget an in-flight tween from its current progress toward a new end. */
export function retargetTween(key: string, newTo: number[], newDurationSec?: number): boolean {
  const tween = active.get(key)
  if (!tween) return false
  const now = performance.now()
  const alpha = Math.min(1, (now - tween.start) / tween.durationMs)
  const eased = tween.ease(alpha)
  const current = tween.from.map((f, i) => f + (tween.to[i] - f) * eased)
  tween.from = current
  tween.to = newTo
  tween.start = now
  if (newDurationSec != null) tween.durationMs = Math.max(1, newDurationSec * 1000)
  return true
}

/** Test helper — drop all tween state between unit checks. */
export function resetTweensForTests(): void {
  active.clear()
  lastNow = 0
}
