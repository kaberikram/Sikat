/**
 * Shared voice session — used by DirectorPod mic and XR push-to-talk.
 * No React; callers pass callbacks.
 *
 * Chrome/Edge get the native (Google-backed) SpeechRecognition API.
 * On browsers without it (Meta Quest Browser, Firefox), falls back to
 * Deepgram Nova-3 via the official @deepgram/sdk — no self-hosted STT needed.
 *
 * While XR is active we prefer Deepgram (Quest mic + accuracy); native Web
 * Speech is skipped when a Deepgram key is present.
 *
 * Chrome's native SpeechRecognition needs a cooldown between stop() and
 * start() — rapid toggles can trigger spurious "language-not-supported".
 * When the native path is cooling down, we fall through to Deepgram.
 *
 * Set VITE_DISABLE_WEBSREECH=true to force Deepgram even when the native
 * Web Speech API is available (useful when native silently fails).
 */

import { DeepgramClient } from '@deepgram/sdk'
import { useEditorStore } from '../store'
import { PCM_CAPTURE_PROCESSOR_NAME, ensurePcmCaptureWorklet } from './pcm-capture-worklet'

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
  /** Live mic RMS level 0..~1, every ~50ms while capturing (Deepgram path only). */
  onLevel?: (level: number) => void
}

// ---- state ----

let recognition: SpeechRecognitionLike | null = null
let deepgramClient: DeepgramClient | null = null
let deepgramConnection: DeepgramConnection | null = null
let deepgramCaptureNode: AudioWorkletNode | ScriptProcessorNode | null = null
let deepgramSource: MediaStreamAudioSourceNode | null = null
let deepgramSink: GainNode | null = null
let deepgramStream: MediaStream | null = null
/**
 * One AudioContext for the app's lifetime, at the hardware's native sample
 * rate. Chromium caps live contexts (~6), so a context per push-to-talk press
 * eventually threw; reuse also skips per-press context startup (~50-150ms) and
 * avoids the 16kHz-vs-48kHz resample garble seen on Quest.
 */
let sharedAudioCtx: AudioContext | null = null
let listening = false
let forceVision = false
let handlers: VoiceSessionHandlers = {}
let finishTimer: ReturnType<typeof setTimeout> | null = null
/** Bumped on every start — stale grace timers / late finals no-op when gen mismatches. */
let sessionGen = 0

/** Minimal interface for the Deepgram SDK connection object. */
interface DeepgramConnection {
  sendMedia(data: ArrayBuffer | Blob | ArrayBufferView): void
  sendCloseStream(data: Record<string, unknown>): void
  close(): void
  connect(): void
  waitForOpen(): Promise<void>
  on(event: string, callback: (...args: any[]) => void): void
}

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

function isWebSpeechDisabled(): boolean {
  return import.meta.env.VITE_DISABLE_WEBSREECH === 'true'
}

function preferDeepgramInXr(): boolean {
  return useEditorStore.getState().xrActive && isDeepgramAvailable()
}

function nativeIsReady(): boolean {
  if (isWebSpeechDisabled()) return false
  if (preferDeepgramInXr()) return false
  return getNativeSpeechRecognitionCtor() !== null && Date.now() >= nativeCooldownUntil
}

// ---- Deepgram path ----

/**
 * Auto-gain off by default: the Quest/headset mic sits at a fixed distance and
 * AGC pumping hurts recognition. Flip to true if testing shows quiet input.
 */
const MIC_AUTO_GAIN = false

/** Deepgram WS handshake timeout — a hung open would otherwise park the session. */
const DG_OPEN_TIMEOUT_MS = 4000

function getDeepgramApiKey(): string | null {
  return (import.meta.env.VITE_DEEPGRAM_API_KEY as string | undefined) ?? null
}

function isDeepgramAvailable(): boolean {
  return getDeepgramApiKey() !== null
}

function getOrCreateDeepgramClient(): DeepgramClient | null {
  const apiKey = getDeepgramApiKey()
  if (!apiKey) return null
  if (!deepgramClient) deepgramClient = new DeepgramClient({ apiKey })
  return deepgramClient
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
  const conn = deepgramConnection
  const node = deepgramCaptureNode
  const source = deepgramSource
  const sink = deepgramSink
  const stream = deepgramStream
  deepgramConnection = null
  deepgramCaptureNode = null
  deepgramSource = null
  deepgramSink = null
  deepgramStream = null

  // The shared AudioContext stays alive — only the capture graph is torn down.
  if (node && 'port' in node) node.port.onmessage = null
  try { source?.disconnect() } catch { /* ignore */ }
  try { node?.disconnect() } catch { /* ignore */ }
  try { sink?.disconnect() } catch { /* ignore */ }
  for (const track of stream?.getTracks() ?? []) track.stop()

  if (conn) {
    try { conn.sendCloseStream({ type: 'CloseStream' }) } catch { /* ignore */ }
    try { conn.close() } catch { /* ignore */ }
  }
}

function failVoiceSession(error: string): void {
  // Invalidate stale callbacks first — a failed session must never fire
  // late finals/handlers after the error is reported.
  sessionGen += 1
  listening = false
  forceVision = false
  clearFinishTimer()
  if (deepgramConnection) deepgramStop()
  detachNativeRecognition()
  handlers.onListeningChange?.(false)
  handlers.onInterim?.('')
  handlers.onError?.(error)
}

function getSharedAudioContext(): AudioContext {
  if (!sharedAudioCtx) {
    // Native hardware rate — no resampling; Deepgram is told the real rate.
    sharedAudioCtx = new AudioContext()
  }
  return sharedAudioCtx
}

async function getMicStream(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: MIC_AUTO_GAIN,
      },
    })
  } catch {
    // Some devices reject specific constraints — retry unconstrained.
    return navigator.mediaDevices.getUserMedia({ audio: true })
  }
}

async function deepgramStart(gen: number): Promise<void> {
  const client = getOrCreateDeepgramClient()
  if (!client) return

  const ctx = getSharedAudioContext()

  // Track partial results so a failure in one parallel step can release the others.
  let pendingStream: MediaStream | null = null
  let pendingConn: DeepgramConnection | null = null

  try {
    // Mic, worklet module, and the Deepgram socket all warm up concurrently —
    // push-to-talk goes live as soon as the slowest of the three is ready.
    const [stream, workletOk, connection] = await Promise.all([
      getMicStream().then((s) => {
        pendingStream = s
        return s
      }),
      ensurePcmCaptureWorklet(ctx),
      (async () => {
        const conn = await client.listen.v1.connect({
          model: 'nova-3',
          language: 'en',
          encoding: 'linear16',
          sample_rate: String(ctx.sampleRate),
          interim_results: 'true',
          smart_format: 'true',
          punctuate: 'true',
          utterance_end_ms: '1500',
        }) as unknown as DeepgramConnection
        pendingConn = conn
        conn.connect()
        await Promise.race([
          conn.waitForOpen(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Deepgram open timeout')), DG_OPEN_TIMEOUT_MS)
          ),
        ])
        return conn
      })(),
      ctx.state === 'suspended' ? ctx.resume() : Promise.resolve(),
    ])

    // Bail if the session was stopped while we were connecting.
    if (gen !== sessionGen) {
      for (const track of stream.getTracks()) track.stop()
      try { connection.close() } catch { /* ignore */ }
      return
    }

    deepgramConnection = connection
    deepgramStream = stream

    connection.on('message', (message) => {
      if (gen !== sessionGen) return
      if (message.type === 'Results') {
        const alt = message.channel?.alternatives?.[0]
        if (!alt || alt.transcript === undefined) return
        const transcript = (alt.transcript as string).trim()
        if (!transcript) return
        if (message.is_final) handlers.onFinal?.(transcript, { forceVision })
        else handlers.onInterim?.(transcript)
      }
      if (message.type === 'UtteranceEnd') {
        // Speech ended. If the user already released push-to-talk (grace
        // drain), close out now instead of waiting the full grace window.
        if (!listening && finishTimer) stopVoiceSession()
      }
      if (message.type === 'Error') {
        console.warn('[voice] Deepgram error:', message.description)
        failVoiceSession('network')
      }
    })

    connection.on('error', () => {
      if (gen !== sessionGen) return
      console.warn('[voice] Deepgram connection error')
      failVoiceSession('network')
    })

    connection.on('close', () => {
      if (gen !== sessionGen) return
      if (connection === deepgramConnection) deepgramStop()
    })

    const source = ctx.createMediaStreamSource(stream)
    deepgramSource = source

    if (workletOk) {
      const node = new AudioWorkletNode(ctx, PCM_CAPTURE_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
      })
      deepgramCaptureNode = node
      node.port.onmessage = (e: MessageEvent) => {
        if (gen !== sessionGen || connection !== deepgramConnection) return
        const msg = e.data as { type: string; data?: ArrayBuffer; level?: number }
        if (msg.type === 'pcm' && msg.data) connection.sendMedia(msg.data)
        else if (msg.type === 'level' && msg.level !== undefined) handlers.onLevel?.(msg.level)
      }
      // Keep the node pulled without an audible path.
      const sink = ctx.createGain()
      sink.gain.value = 0
      deepgramSink = sink
      source.connect(node)
      node.connect(sink)
      sink.connect(ctx.destination)
    } else {
      // Fallback for engines without AudioWorklet.
      const proc = ctx.createScriptProcessor(4096, 1, 1)
      deepgramCaptureNode = proc
      proc.onaudioprocess = (e) => {
        if (gen === sessionGen && connection === deepgramConnection) {
          const samples = e.inputBuffer.getChannelData(0)
          connection.sendMedia(float32ToPcm16(samples))
          if (handlers.onLevel) {
            let sumSq = 0
            for (let i = 0; i < samples.length; i += 16) sumSq += samples[i] * samples[i]
            handlers.onLevel(Math.sqrt(sumSq / Math.ceil(samples.length / 16)))
          }
        }
      }
      source.connect(proc)
      proc.connect(ctx.destination)
    }

    handlers.onListeningChange?.(true)
  } catch (err) {
    console.warn('[voice] Deepgram session failed:', err)
    for (const track of (pendingStream as MediaStream | null)?.getTracks() ?? []) track.stop()
    try { (pendingConn as DeepgramConnection | null)?.close() } catch { /* ignore */ }
    if (gen !== sessionGen) return
    const notAllowed = err instanceof DOMException &&
      (err.name === 'NotAllowedError' || err.name === 'SecurityError')
    failVoiceSession(notAllowed ? 'not-allowed' : 'network')
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

export function isDeepgramConfigured(): boolean {
  return isDeepgramAvailable()
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
  sessionGen += 1

  if (deepgramConnection) deepgramStop()
  detachNativeRecognition()

  handlers.onListeningChange?.(false)
  handlers.onInterim?.('')
}

export function finishVoiceSession(): void {
  if (!listening) return
  const gen = sessionGen
  listening = false
  handlers.onListeningChange?.(false)
  handlers.onInterim?.('')

  if (deepgramConnection) {
    const conn = deepgramConnection
    try { conn.sendCloseStream({ type: 'CloseStream' }) } catch { /* ignore */ }
    clearFinishTimer()
    finishTimer = setTimeout(() => {
      if (gen !== sessionGen) return
      if (deepgramConnection === conn) stopVoiceSession()
    }, FINISH_GRACE_MS)
    return
  }

  if (recognition) {
    const rec = recognition
    detachNativeRecognition()
    clearFinishTimer()
    finishTimer = setTimeout(() => {
      if (gen !== sessionGen) return
      if (recognition === rec) return // already replaced by a new session
      listening = false
      handlers.onListeningChange?.(false)
      handlers.onInterim?.('')
    }, FINISH_GRACE_MS)
  }
}

export async function startVoiceSession(
  next: VoiceSessionHandlers,
  opts?: { forceVision?: boolean }
): Promise<void> {
  clearFinishTimer()
  // Tear down any live or draining session.
  if (recognition || deepgramConnection) stopVoiceSession()

  sessionGen += 1
  const gen = sessionGen
  handlers = next
  if (opts?.forceVision) forceVision = true
  listening = true

  const xrActive = useEditorStore.getState().xrActive
  if (xrActive && !isDeepgramAvailable() && getNativeSpeechRecognitionCtor() === null) {
    listening = false
    handlers.onError?.('voice needs Deepgram key')
    return
  }

  if (nativeIsReady()) {
    const rec = new (getNativeSpeechRecognitionCtor()!)()
    rec.lang = 'en-US'
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1

    rec.onresult = (event) => {
      if (gen !== sessionGen) return
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
      if (gen !== sessionGen) return
      if (
        event.error === 'not-allowed' ||
        event.error === 'service-not-allowed'
      ) {
        failVoiceSession(event.error)
      } else if (event.error === 'network') {
        failVoiceSession(event.error)
      } else if (event.error === 'language-not-supported') {
        // Chrome throws this on rapid stop/start. Give it a longer cooldown,
        // then retry via Deepgram if available.
        detachNativeRecognition()
        nativeCooldownUntil = Date.now() + NATIVE_COOLDOWN_MS
        if (isDeepgramAvailable()) {
          deepgramStart(gen)
          return
        }
        failVoiceSession(event.error)
      }
    }

    rec.onend = () => {
      if (gen !== sessionGen || recognition !== rec) return
      if (!listening) {
        stopVoiceSession()
        return
      }
      // Chrome auto-ends on silence — restart while the mic is held open.
      try { rec.start() } catch { failVoiceSession('network') }
    }

    recognition = rec
    handlers.onListeningChange?.(true)
    handlers.onInterim?.('')
    try {
      rec.start()
    } catch {
      failVoiceSession('network')
    }
  } else if (isDeepgramAvailable()) {
    deepgramStart(gen)
  } else if (xrActive) {
    listening = false
    handlers.onError?.('voice needs Deepgram key')
  } else {
    // Native is cooling down and Deepgram isn't configured.
    listening = false
    handlers.onError?.('voice unavailable — native API cooling down, try again')
  }
}

export async function toggleVoiceSession(
  next: VoiceSessionHandlers,
  opts?: { forceVision?: boolean }
): Promise<void> {
  if (listening) finishVoiceSession()
  else await startVoiceSession(next, opts)
}
