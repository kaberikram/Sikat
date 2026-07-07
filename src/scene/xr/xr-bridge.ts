let enterXrSession: (() => Promise<void>) | null = null

export function registerXrSessionEntry(fn: (() => Promise<void>) | null): void {
  enterXrSession = fn
}

export async function requestXrSession(): Promise<void> {
  if (!enterXrSession) throw new Error('XR session not initialized')
  await enterXrSession()
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
