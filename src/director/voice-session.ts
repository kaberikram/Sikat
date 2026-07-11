/**
 * Shared Web Speech session — used by DirectorPod mic and XR push-to-talk.
 * No React; callers pass callbacks.
 *
 * Falls back to the SEPIA SpeechRecognition polyfill (self-hosted STT server)
 * on browsers without a native implementation, e.g. Meta Quest Browser.
 */
import {
  sepiaSpeechRecognitionInit,
  SepiaSpeechRecognitionConfig,
} from 'sepia-speechrecognition-polyfill'

interface SpeechResultEvent {
  resultIndex: number
  results: ArrayLike<{
    isFinal: boolean
    0?: { transcript?: string }
  }>
}

interface SpeechErrorEvent {
  error: string
}

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onresult: ((event: SpeechResultEvent) => void) | null
  onend: (() => void) | null
  onerror: ((event: SpeechErrorEvent) => void) | null
  start: () => void
  stop: () => void
}

export interface VoiceSessionHandlers {
  onInterim?: (text: string) => void
  onFinal?: (text: string, opts: { forceVision: boolean }) => void
  onListeningChange?: (listening: boolean) => void
  /** Fatal recognition error ('not-allowed', 'network', …) — session already stopped. */
  onError?: (error: string) => void
}

/**
 * How long to keep a stopped session's handlers alive waiting for the last
 * final transcript. The SEPIA polyfill's own final-result fallback timer is
 * 4s, so wait slightly longer than that.
 */
const FINISH_GRACE_MS = 5000

let recognition: SpeechRecognitionLike | null = null
let recognitionIsPolyfill = false
let listening = false
let forceVision = false
let handlers: VoiceSessionHandlers = {}
let finishTimer: ReturnType<typeof setTimeout> | null = null
// Polyfill capture state, tracked via its audiostart/audioend events. Needed
// because polyfill start/stop share one toggle: calling stop() on an idle
// recorder would *open* the mic, so only toggle while it's opening or open.
let polyfillStartPending = false
let polyfillMicOpen = false

const noop = (): void => {}

function getNativeSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as Record<string, unknown>
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as
    | (new () => SpeechRecognitionLike)
    | null
}

/**
 * Where the SEPIA STT server lives. Same insecure-content rule as the
 * director socket: an HTTPS page may not talk to a plain-http STT server,
 * so in that case require an explicit VITE_SEPIA_STT_URL.
 */
function sepiaServerUrl(): string | null {
  const configured = import.meta.env.VITE_SEPIA_STT_URL as string | undefined
  if (configured) return configured
  if (typeof location === 'undefined') return null
  if (location.protocol === 'https:') return null
  return `http://${location.hostname}:20741`
}

let sepiaCtor: (new () => SpeechRecognitionLike) | null | undefined

function getSepiaSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (sepiaCtor !== undefined) return sepiaCtor
  const serverUrl = sepiaServerUrl()
  if (!serverUrl) {
    console.log('[voice] SEPIA STT server URL not configured — polyfill unavailable')
    sepiaCtor = null
    return null
  }
  console.log('[voice] initialising SEPIA polyfill — server:', serverUrl)
  const config = new SepiaSpeechRecognitionConfig()
  config.serverUrl = serverUrl
  const accessToken = import.meta.env.VITE_SEPIA_STT_TOKEN as string | undefined
  if (accessToken) {
    config.accessToken = accessToken
    console.log('[voice] SEPIA auth token set')
  }
  sepiaCtor = sepiaSpeechRecognitionInit(config) as new () => SpeechRecognitionLike
  console.log('[voice] SEPIA polyfill initialised')
  return sepiaCtor
}

export function isSpeechAvailable(): boolean {
  return (
    getNativeSpeechRecognitionCtor() !== null ||
    getSepiaSpeechRecognitionCtor() !== null
  )
}

/**
 * Explicitly prompt for mic access via getUserMedia. SpeechRecognition alone
 * doesn't surface a permission dialog inside an immersive WebXR session (no
 * dom-overlay to render it in, e.g. Meta Quest Browser), so callers should
 * request this up front while still in the regular 2D page — the resulting
 * grant carries over once XR starts.
 */
export async function requestMicPermission(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    console.warn('[mic] getUserMedia unavailable (insecure context or unsupported browser)')
    return false
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    for (const track of stream.getTracks()) track.stop()
    return true
  } catch (err) {
    console.warn('[mic] permission request failed:', err)
    return false
  }
}

export function isVoiceListening(): boolean {
  return listening
}

function clearFinishTimer(): void {
  if (finishTimer) {
    clearTimeout(finishTimer)
    finishTimer = null
  }
}

function detachRecognition(opts: { stop: boolean }): void {
  clearFinishTimer()
  const rec = recognition
  recognition = null
  recognitionIsPolyfill = false
  polyfillStartPending = false
  if (!rec) return
  // No-op handlers, not null: the SEPIA polyfill dispatches events
  // unconditionally, so a null handler would throw.
  rec.onresult = noop
  rec.onend = noop
  rec.onerror = noop
  if (opts.stop) {
    try {
      rec.stop()
    } catch {
      /* already stopped */
    }
  }
}

export function stopVoiceSession(): void {
  const stillCapturing = recognitionIsPolyfill
    ? polyfillStartPending || polyfillMicOpen
    : listening
  listening = false
  forceVision = false
  handlers.onListeningChange?.(false)
  handlers.onInterim?.('')
  detachRecognition({ stop: stillCapturing })
}

/**
 * Stop capturing but keep result handlers alive for a grace period: both
 * Chrome and the SEPIA polyfill deliver the last final transcript *after*
 * stop(), so tearing down immediately on push-to-talk release would drop
 * any utterance that hadn't finalized yet.
 */
export function finishVoiceSession(): void {
  const rec = recognition
  if (!rec || !listening) return
  listening = false
  handlers.onListeningChange?.(false)
  handlers.onInterim?.('')
  try {
    rec.stop()
  } catch {
    stopVoiceSession()
    return
  }
  polyfillStartPending = false
  clearFinishTimer()
  finishTimer = setTimeout(() => {
    if (recognition === rec) stopVoiceSession()
  }, FINISH_GRACE_MS)
}

export function startVoiceSession(
  next: VoiceSessionHandlers,
  opts?: { forceVision?: boolean }
): void {
  const NativeCtor = getNativeSpeechRecognitionCtor()
  const Recognition = NativeCtor ?? getSepiaSpeechRecognitionCtor()
  if (!Recognition) {
    console.log('[voice] no speech recognition available')
    return
  }
  const polyfilled = !NativeCtor
  console.log('[voice] using', polyfilled ? 'SEPIA polyfill' : 'native SpeechRecognition')
  // Take over any live or draining session (desktop mic ↔ XR hold-A).
  if (recognition) stopVoiceSession()

  handlers = next
  if (opts?.forceVision) forceVision = true

  const rec = new Recognition()
  rec.lang = 'en-US'
  rec.continuous = true
  rec.interimResults = true
  rec.maxAlternatives = 1

  if (polyfilled) {
    const recEvents = rec as unknown as {
      addEventListener?: (type: string, cb: () => void) => void
    }
    recEvents.addEventListener?.('audiostart', () => {
      console.log('[voice] polyfill audiostart — mic open')
      if (recognition === rec) {
        polyfillStartPending = false
        polyfillMicOpen = true
      }
    })
    recEvents.addEventListener?.('audioend', () => {
      console.log('[voice] polyfill audioend — mic closed')
      polyfillMicOpen = false
    })
  }

  rec.onresult = (event) => {
    let ghost = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      const transcript = result[0]?.transcript ?? ''
      if (result.isFinal) handlers.onFinal?.(transcript, { forceVision })
      else ghost += transcript
    }
    handlers.onInterim?.(ghost)
  }

  rec.onerror = (event) => {
    console.log('[voice] error:', event.error)
    if (
      event.error === 'not-allowed' ||
      event.error === 'service-not-allowed' ||
      event.error === 'language-not-supported'
    ) {
      // The polyfill's recorder never opened the mic on these (init/auth
      // failures) — clear capture flags so we don't toggle it back on.
      polyfillStartPending = false
      polyfillMicOpen = false
      stopVoiceSession()
      handlers.onError?.(event.error)
    } else if (event.error === 'network') {
      stopVoiceSession()
      handlers.onError?.(event.error)
    }
  }

  rec.onend = () => {
    if (recognition !== rec) return
    if (!listening || polyfilled) {
      // Draining after finishVoiceSession(), or the polyfill's STT socket
      // disconnected. Don't restart: on the polyfill start/stop share one
      // toggle, so a "restart" could stop a live mic instead.
      stopVoiceSession()
      return
    }
    // Chrome ends sessions on silence — restart while the mic is held open.
    try {
      rec.start()
    } catch {
      stopVoiceSession()
    }
  }

  recognition = rec
  recognitionIsPolyfill = polyfilled
  listening = true
  if (polyfilled) polyfillStartPending = true
  handlers.onListeningChange?.(true)
  handlers.onInterim?.('')
  try {
    rec.start()
  } catch {
    polyfillStartPending = false
    stopVoiceSession()
  }
}

export function toggleVoiceSession(
  next: VoiceSessionHandlers,
  opts?: { forceVision?: boolean }
): void {
  if (listening) finishVoiceSession()
  else startVoiceSession(next, opts)
}
