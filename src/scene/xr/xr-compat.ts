/**
 * Chrome 147+ exposes native WebXR Layers (`XRWebGLBinding.createProjectionLayer`).
 * Meta Immersive Web Emulator polyfills `XRSession` incompatibly — Three.js r179+
 * then throws when constructing the binding. Probe the session and fall back to
 * the legacy `XRWebGLLayer` path when needed. See three.js #31432.
 *
 * Do NOT delete `XRWebGLBinding` — WebXRManager caches support at renderer init
 * but still references the global name in `setSession`.
 */
export function forceLegacyXrLayerIfNeeded(session: XRSession, gl: WebGLRenderingContext): void {
  if (typeof XRWebGLBinding === 'undefined') return
  if (!('createProjectionLayer' in XRWebGLBinding.prototype)) return

  try {
    new XRWebGLBinding(session, gl)
  } catch {
    delete (XRWebGLBinding.prototype as { createProjectionLayer?: unknown }).createProjectionLayer
  }
}
