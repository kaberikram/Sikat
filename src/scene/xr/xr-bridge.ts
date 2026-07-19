let enterXrSession: (() => Promise<void>) | null = null
let endXrSessionFn: (() => Promise<void>) | null = null
let stagePlacer: (() => void) | null = null
let reviewRecall: (() => boolean) | null = null

/** The camcorder rig registers this; places the stage in front of the user's head. */
export function registerStagePlacer(fn: (() => void) | null): void {
  stagePlacer = fn
}

/** No-op outside an active XR session (nothing registered). */
export function placeStageAtUser(): void {
  stagePlacer?.()
}

/** The review screen registers this; re-places the take monitor in front of the head. */
export function registerReviewRecall(fn: (() => boolean) | null): void {
  reviewRecall = fn
}

/** True when a take monitor was open and got recalled. */
export function recallReviewScreen(): boolean {
  return reviewRecall?.() ?? false
}

export function registerXrSessionEntry(fn: (() => Promise<void>) | null): void {
  enterXrSession = fn
}

export function registerXrSessionExit(fn: (() => Promise<void>) | null): void {
  endXrSessionFn = fn
}

export async function requestXrSession(): Promise<void> {
  if (!enterXrSession) throw new Error('XR session not initialized')
  await enterXrSession()
}

export async function endXrSession(): Promise<void> {
  if (!endXrSessionFn) return
  await endXrSessionFn()
}

export async function probeImmersiveArSupport(): Promise<boolean> {
  return probeXrSupport()
}

/** True when immersive-ar or immersive-vr is available (Chrome WebXR emulator uses VR). */
export async function probeXrSupport(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.xr?.isSessionSupported) return false
  try {
    const [ar, vr] = await Promise.all([
      navigator.xr.isSessionSupported('immersive-ar'),
      navigator.xr.isSessionSupported('immersive-vr'),
    ])
    return ar || vr
  } catch {
    return false
  }
}
