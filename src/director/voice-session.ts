/**
 * Shared voice session — used by DirectorPod mic and XR push-to-talk.
 * No React; callers pass callbacks.
 *
 * Chrome/Edge get the native (Google-backed) SpeechRecognition API.
 * On browsers without it (Meta Quest Browser, Firefox), falls back to
 * Deepgram Nova-2 over a direct WebSocket — no self-hosted STT server needed.
 *
 * Chrome's native SpeechRecognition needs a cooldown between stop() and
 * start() — rapid toggles can trigger spurious "language-not-supported".
 * When the native path is cooling down, we fall through to Deepgram.
 */

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

// ---- state ----

let recognition: SpeechRecognitionLike | null = null
let deepgramWs: WebSocket | null = null
let deepgramAudioCtx: AudioContext | null = null
let deepgramProcessor: ScriptProcessorNode | null = null
let deepgramStream: MediaStream | null = null
let listening = false
let forceVision = false
let handlers: VoiceSessionHandlers = {}
let finishTimer: ReturnType<typeof setTimeout> | null = null

/**
 * After a native session stops, we block new native starts for this many ms.
 * Chrome's SpeechRecognition throws "language-not-supported" if you call
 * start() too soon after stop().
 */
const NATIVE_COOLDOWN_MS = 500

/** Timestamp (ms) when the last native session ended. 0 = no cooldown active. */
let nativeCooldownUntil = 0

const FINISH_GRACE_MS = 5000

// ---- native path ----

function getNativeSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as Record<string, unknown>
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as
    | (new () => SpeechRecognitionLike)
    | null
}

function nativeIsReady(): boolean {
  return getNativeSpeechRecognitionCtor() !== null && Date.now() >= nativeCooldownUntil
}

// ---- Deepgram path ----

const DG_WS_URL = 'wss://api.deepgram.com/v1/listen'
const DG_SAMPLE_RATE = 16000

function getDeepgramApiKey(): string | null {
  return (import.meta.env.VITE_DEEPGRAM_API_KEY as string | undefined) ?? null
}

function isDeepgramAvailable(): boolean {
  return getDeepgramApiKey() !== null
}

/**
 * Convert Float32 audio samples to 16-bit PCM little-endian bytes.
 */
function float32ToPcm16(buffer: Float32Array): ArrayBuffer {
  const out = new ArrayBuffer(buffer.length * 2)
  const view = new DataView(out)
  for (let i = 0; i < buffer.length; i++) {
    const s = Math.max(-1, Math.min(1, buffer[i]))
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return out
}

function deepgramStop(): void {
  const ws = deepgramWs
  const ctx = deepgramAudioCtx
  const proc = deepgramProcessor
  const stream = deepgramStream
  deepgramWs = null
  deepgramAudioCtx = null
  deepgramProcessor = null
  deepgramStream = null

  try { proc?.disconnect() } catch { /* ignore */ }
  try { ctx?.close() } catch { /* ignore */ }
  for (const track of stream?.getTracks() ?? []) track.stop()

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    try { ws.send(JSON.stringify({ type: 'CloseStream' })) } catch { /* ignore */ }
    ws.close()
  }
}

function deepgramStart(): void {
  const apiKey = getDeepgramApiKey()
  if (!apiKey) return

  const ws = new WebSocket(DG_WS_URL, ['token', apiKey])
  deepgramWs = ws

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'Configure',
      features: {
        model: 'nova-2',
        encoding: 'linear16',
        sample_rate: DG_SAMPLE_RATE,
        channels: 1,
        interim_results: true,
        utterance_end_ms: 1000,
        smart_format: true,
        punctuate: true,
      },
    }))

    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      deepgramStream = stream
      const ctx = new AudioContext({ sampleRate: DG_SAMPLE_RATE })
      deepgramAudioCtx = ctx

      const source = ctx.createMediaStreamSource(stream)
      // ScriptProcessorNode is deprecated but works everywhere including
      // Quest Browser, where AudioWorklet has spotty support.
      const proc = ctx.createScriptProcessor(4096, 1, 1)
      deepgramProcessor = proc

      proc.onaudioprocess = (e) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(float32ToPcm16(e.inputBuffer.getChannelData(0)))
        }
      }

      source.connect(proc)
      proc.connect(ctx.destination)
      handlers.onListeningChange?.(true)
    }).catch((err) => {
      console.warn('[voice] getUserMedia failed:', err)
      handlers.onError?.('not-allowed')
      deepgramStop()
    })
  }

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data as string)
      if (msg.type === 'Results') {
        const channel = msg.channel
        const alt = channel?.alternatives?.[0]
        if (!alt || alt.transcript === undefined) return
        const transcript = (alt.transcript as string).trim()
        if (!transcript) return
        if (msg.is_final) handlers.onFinal?.(transcript, { forceVision })
        else handlers.onInterim?.(transcript)
      }
      if (msg.type === 'Error') {
        console.warn('[voice] Deepgram error:', msg.description)
        handlers.onError?.('network')
        deepgramStop()
      }
    } catch { /* ignore unparseable messages */ }
  }

  ws.onerror = () => {
    handlers.onError?.('network')
    deepgramStop()
  }

  ws.onclose = () => {
    if (ws === deepgramWs) deepgramStop()
  }
}

// ---- cleanup helpers ----

function clearFinishTimer(): void {
  if (finishTimer) {
    clearTimeout(finishTimer)
    finishTimer = null
  }
}

function detachNativeRecognition(): void {
  if (!recognition) return
  const rec = recognition
  recognition = null
  rec.onresult = null
  rec.onend = null
  rec.onerror = null
  try { rec.stop() } catch { /* already stopped */ }
  nativeCooldownUntil = Date.now() + NATIVE_COOLDOWN_MS
}

// ---- public API ----

export function isSpeechAvailable(): boolean {
  return getNativeSpeechRecognitionCtor() !== null || isDeepgramAvailable()
}

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

export function stopVoiceSession(): void {
  listening = false
  forceVision = false
  clearFinishTimer()

  if (deepgramWs) deepgramStop()
  detachNativeRecognition()

  handlers.onListeningChange?.(false)
  handlers.onInterim?.('')
}

export function finishVoiceSession(): void {
  if (!listening) return
  listening = false
  handlers.onListeningChange?.(false)
  handlers.onInterim?.('')

  if (deepgramWs) {
    const ws = deepgramWs
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'CloseStream' })) } catch { /* ignore */ }
    }
    clearFinishTimer()
    finishTimer = setTimeout(() => {
      if (deepgramWs === ws) stopVoiceSession()
    }, FINISH_GRACE_MS)
    return
  }

  if (recognition) {
    const rec = recognition
    detachNativeRecognition()
    clearFinishTimer()
    finishTimer = setTimeout(() => {
      if (recognition === rec) return // already replaced by a new session
      // Grace period expired — full teardown.
      listening = false
      handlers.onListeningChange?.(false)
      handlers.onInterim?.('')
    }, FINISH_GRACE_MS)
  }
}

export function startVoiceSession(
  next: VoiceSessionHandlers,
  opts?: { forceVision?: boolean }
): void {
  // Tear down any live or draining session.
  if (recognition || deepgramWs) stopVoiceSession()

  handlers = next
  if (opts?.forceVision) forceVision = true
  listening = true

  if (nativeIsReady()) {
    const rec = new (getNativeSpeechRecognitionCtor()!)()
    rec.lang = 'en-US'
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1

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
      if (
        event.error === 'not-allowed' ||
        event.error === 'service-not-allowed'
      ) {
        stopVoiceSession()
        handlers.onError?.(event.error)
      } else if (event.error === 'network') {
        stopVoiceSession()
        handlers.onError?.(event.error)
      } else if (event.error === 'language-not-supported') {
        // Chrome throws this on rapid stop/start. Give it a longer cooldown,
        // then retry via Deepgram if available.
        detachNativeRecognition()
        nativeCooldownUntil = Date.now() + NATIVE_COOLDOWN_MS
        if (isDeepgramAvailable()) {
          deepgramStart()
          return
        }
        stopVoiceSession()
        handlers.onError?.(event.error)
      }
    }

    rec.onend = () => {
      if (recognition !== rec) return
      if (!listening) {
        stopVoiceSession()
        return
      }
      // Chrome auto-ends on silence — restart while the mic is held open.
      try { rec.start() } catch { stopVoiceSession() }
    }

    recognition = rec
    handlers.onListeningChange?.(true)
    handlers.onInterim?.('')
    try {
      rec.start()
    } catch {
      stopVoiceSession()
    }
  } else if (isDeepgramAvailable()) {
    deepgramStart()
  } else {
    // Native is cooling down and Deepgram isn't configured.
    listening = false
    handlers.onError?.('voice unavailable — native API cooling down, try again')
  }
}

export function toggleVoiceSession(
  next: VoiceSessionHandlers,
  opts?: { forceVision?: boolean }
): void {
  if (listening) finishVoiceSession()
  else startVoiceSession(next, opts)
}
