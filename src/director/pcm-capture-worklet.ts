/**
 * AudioWorklet processor for mic capture — converts Float32 → Int16 PCM off
 * the main thread and posts transferred buffers, plus a cheap RMS level every
 * ~50ms for UI meters.
 *
 * Shipped as a source string loaded via a Blob URL so it needs no separately
 * served asset (works on Quest Browser over LAN dev servers).
 */

export const PCM_CAPTURE_PROCESSOR_NAME = 'pcm-capture'

const PCM_CAPTURE_WORKLET_SRC = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Int16Array(2048)
    this.len = 0
    this.levelAcc = 0
    this.levelCount = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    let buf = this.buf
    let len = this.len
    let sumSq = 0
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]))
      sumSq += s * s
      buf[len++] = s < 0 ? s * 0x8000 : s * 0x7fff
      if (len === buf.length) {
        this.port.postMessage({ type: 'pcm', data: buf.buffer }, [buf.buffer])
        buf = this.buf = new Int16Array(2048)
        len = 0
      }
    }
    this.len = len
    this.levelAcc += sumSq
    this.levelCount += ch.length
    if (this.levelCount >= sampleRate * 0.05) {
      this.port.postMessage({ type: 'level', level: Math.sqrt(this.levelAcc / this.levelCount) })
      this.levelAcc = 0
      this.levelCount = 0
    }
    return true
  }
}
registerProcessor('${PCM_CAPTURE_PROCESSOR_NAME}', PcmCaptureProcessor)
`

let moduleUrl: string | null = null
const loadedContexts = new WeakMap<AudioContext, Promise<boolean>>()

/** Load the capture worklet into a context (once per context). Resolves false when AudioWorklet is unavailable. */
export function ensurePcmCaptureWorklet(ctx: AudioContext): Promise<boolean> {
  if (!ctx.audioWorklet) return Promise.resolve(false)
  let ready = loadedContexts.get(ctx)
  if (!ready) {
    if (!moduleUrl) {
      moduleUrl = URL.createObjectURL(
        new Blob([PCM_CAPTURE_WORKLET_SRC], { type: 'application/javascript' })
      )
    }
    ready = ctx.audioWorklet
      .addModule(moduleUrl)
      .then(() => true)
      .catch((e) => {
        console.warn('[voice] AudioWorklet load failed, falling back to ScriptProcessor:', e)
        return false
      })
    loadedContexts.set(ctx, ready)
  }
  return ready
}
