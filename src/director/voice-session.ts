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
 *
 * The Deepgram capture graph is built once and kept warm (primeVoiceCapture),
 * and PCM spoken before the socket finishes connecting is buffered and flushed
 * on open — together those keep the first word of a hold from being clipped.
 */

import { DeepgramClient } from '@deepgram/sdk'
import { useEditorStore } from '../store'
import { DIRECTOR_KEYTERMS } from './local-grammar'
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
/** True between socket open and close — audio only streams while this holds. */
let deepgramOpen = false
/** True while the handshake is in flight, so a release can wait for it. */
let deepgramConnecting = false
/**
 * A release that arrived before the socket finished connecting. Held here and
 * run the moment the socket is up, so a short hold on a cold start still gets
 * its buffered audio transcribed instead of submitting nothing.
 */
let pendingDrain: { gen: number; fv: boolean } | null = null
/**
 * One AudioContext for the app's lifetime, at the hardware's native sample
 * rate. Chromium caps live contexts (~6), so a context per push-to-talk press
 * eventually threw; reuse also skips per-press context startup (~50-150ms) and
 * avoids the 16kHz-vs-48kHz resample garble seen on Quest.
 */
let sharedAudioCtx: AudioContext | null = null

/**
 * The mic capture graph. Built once and kept warm across presses (see
 * primeVoiceCapture) — building it per press cost a `getUserMedia` plus an
 * AudioWorklet module load, several hundred ms on Quest, during which the
 * user was already talking.
 */
interface CaptureRig {
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  node: AudioWorkletNode | ScriptProcessorNode
  sink: GainNode
}

let captureRig: CaptureRig | null = null
let rigPromise: Promise<CaptureRig> | null = null
/** Gate on the warm graph — frames are dropped unless a hold is live. */
let capturing = false
/**
 * PCM captured before the Deepgram socket finished its handshake. Flushed in
 * order on open, so the first word of a hold survives the connect latency
 * instead of being spoken into a socket that isn't there yet.
 */
let pendingChunks: ArrayBuffer[] = []
let pendingBytes = 0
/** ~4s of 48kHz mono int16 — covers the connect budget, bounds the memory. */
const MAX_PENDING_BYTES = 4 * 48_000 * 2
let listening = false
let forceVision = false
let handlers: VoiceSessionHandlers = {}
let finishTimer: ReturnType<typeof setTimeout> | null = null
/** Bumped on every start — stale grace timers / late finals no-op when gen mismatches. */
let sessionGen = 0
/**
 * Segments the engine has marked final, accumulated across the whole hold.
 * Hold-to-talk contract: nothing is submitted until release — a mid-hold
 * pause finalizing a segment must not fire a command early, and the words
 * must not disappear from the display while you keep talking. Reset only at
 * the top of startVoiceSession; a hard stop leaves it for the next start to
 * clear, so a graceful finish that reads-then-stops is never raced.
 */
let finalSegments: string[] = []

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

/**
 * Backstop only. The socket's own close (after CloseStream) and Deepgram's
 * UtteranceEnd both finish the hold sooner — this just bounds the wait when
 * neither arrives, and it is the delay the user feels when they don't.
 *
 * It sits at the very front of the latency chain: nothing else in the system
 * can start until the transcript is dispatched, so every millisecond here is
 * added to every other cost. Trimmed to roughly the round-trip it is guarding,
 * on the reasoning that a backstop longer than the thing it backs up is just
 * dead air. The words themselves are safe either way — `finalSegments` has
 * already accumulated them, so a short grace risks a late *tail*, not the
 * utterance.
 */
const FINISH_GRACE_MS = 600
/** Backstop only — rec.stop() -> onend normally resolves in well under this. */
const NATIVE_STOP_GRACE_MS = 400

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

/** Close the Deepgram socket and stop feeding it. The capture rig stays warm. */
function deepgramStop(): void {
  const conn = deepgramConnection
  deepgramConnection = null
  deepgramOpen = false
  capturing = false
  pendingChunks = []
  pendingBytes = 0

  if (conn) {
    try { conn.sendCloseStream({ type: 'CloseStream' }) } catch { /* ignore */ }
    try { conn.close() } catch { /* ignore */ }
  }
}

/** Route one PCM chunk: straight to the socket if it's up, buffered if not. */
function sendOrBufferPcm(data: ArrayBuffer): void {
  const conn = deepgramConnection
  if (conn && deepgramOpen) {
    conn.sendMedia(data)
    return
  }
  if (pendingBytes + data.byteLength > MAX_PENDING_BYTES) return
  pendingChunks.push(data)
  pendingBytes += data.byteLength
}

/**
 * Ask Deepgram to finalize, then wait for the tail. The socket's close and
 * UtteranceEnd both short-circuit the timer; it only bounds the wait when
 * neither arrives.
 */
function beginDeepgramDrain(gen: number, fv: boolean): void {
  const conn = deepgramConnection
  if (!conn) return
  try { conn.sendCloseStream({ type: 'CloseStream' }) } catch { /* ignore */ }
  clearFinishTimer()
  finishTimer = setTimeout(() => {
    if (gen !== sessionGen) return
    if (deepgramConnection === conn) {
      stopVoiceSession()
      emitFinalAndReset(fv)
    }
  }, FINISH_GRACE_MS)
}

function flushPendingPcm(conn: DeepgramConnection): void {
  for (const chunk of pendingChunks) {
    try { conn.sendMedia(chunk) } catch { /* socket died mid-flush */ }
  }
  pendingChunks = []
  pendingBytes = 0
}

/**
 * Build the mic → worklet → (silent) sink graph, once. Rejects when the mic is
 * unavailable; the caller turns that into a session error.
 */
function ensureCaptureRig(ctx: AudioContext): Promise<CaptureRig> {
  if (captureRig) return Promise.resolve(captureRig)
  if (rigPromise) return rigPromise

  rigPromise = (async () => {
    let stream: MediaStream
    let workletOk: boolean
    try {
      ;[stream, workletOk] = await Promise.all([getMicStream(), ensurePcmCaptureWorklet(ctx)])
    } catch (err) {
      // Let the next press try again rather than caching the failure.
      rigPromise = null
      throw err
    }
    const source = ctx.createMediaStreamSource(stream)
    // Zero-gain sink: the node has to stay pulled, but must never be audible.
    const sink = ctx.createGain()
    sink.gain.value = 0
    sink.connect(ctx.destination)

    let node: AudioWorkletNode | ScriptProcessorNode
    if (workletOk) {
      const worklet = new AudioWorkletNode(ctx, PCM_CAPTURE_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
      })
      worklet.port.onmessage = (e: MessageEvent) => {
        if (!capturing) return
        const msg = e.data as { type: string; data?: ArrayBuffer; level?: number }
        if (msg.type === 'pcm' && msg.data) sendOrBufferPcm(msg.data)
        else if (msg.type === 'level' && msg.level !== undefined) handlers.onLevel?.(msg.level)
      }
      node = worklet
    } else {
      // Fallback for engines without AudioWorklet.
      const proc = ctx.createScriptProcessor(4096, 1, 1)
      proc.onaudioprocess = (e) => {
        if (!capturing) return
        const samples = e.inputBuffer.getChannelData(0)
        sendOrBufferPcm(float32ToPcm16(samples))
        if (handlers.onLevel) {
          let sumSq = 0
          for (let i = 0; i < samples.length; i += 16) sumSq += samples[i] * samples[i]
          handlers.onLevel(Math.sqrt(sumSq / Math.ceil(samples.length / 16)))
        }
      }
      node = proc
    }

    source.connect(node)
    node.connect(sink)
    captureRig = { stream, source, node, sink }
    return captureRig
  })()

  return rigPromise
}

/**
 * Warm the mic path ahead of the first press. Call from a real user gesture —
 * it also creates and resumes the shared AudioContext, which headset browsers
 * leave suspended (and a suspended context silently starves both the capture
 * graph and the set's sound design).
 */
export async function primeVoiceCapture(): Promise<boolean> {
  // The shared context carries the set's sound design too, so resume it on any
  // gesture — whether or not Deepgram is the engine on this device.
  try {
    const ctx = getSharedAudioContext()
    if (ctx.state === 'suspended') await ctx.resume()
  } catch { /* context unavailable — sound and capture degrade on their own */ }
  if (!isDeepgramAvailable()) return false
  try {
    await ensureCaptureRig(getSharedAudioContext())
    return true
  } catch (err) {
    console.warn('[voice] priming capture failed:', err)
    return false
  }
}

/** Drop the warm mic — the recording indicator should not outlive the session. */
export function releaseVoiceCapture(): void {
  const rig = captureRig
  captureRig = null
  rigPromise = null
  capturing = false
  pendingChunks = []
  pendingBytes = 0
  if (!rig) return
  if ('port' in rig.node) rig.node.port.onmessage = null
  else rig.node.onaudioprocess = null
  try { rig.source.disconnect() } catch { /* ignore */ }
  try { rig.node.disconnect() } catch { /* ignore */ }
  try { rig.sink.disconnect() } catch { /* ignore */ }
  for (const track of rig.stream.getTracks()) track.stop()
}

function pushFinalSegment(text: string): void {
  const t = text.trim()
  if (t) finalSegments.push(t)
}

/** The full running transcript so far — confirmed segments plus the live tail. */
function runningTranscript(ghost: string): string {
  return [...finalSegments, ghost].filter(Boolean).join(' ')
}

/**
 * The one and only submit point: called once the session is fully finished
 * (release + grace drain, or a flushed native stop). `fv` is snapshotted by
 * the caller before any teardown that might reset the module-level forceVision.
 */
function emitFinalAndReset(fv: boolean): void {
  const text = finalSegments.join(' ').trim()
  finalSegments = []
  handlers.onFinal?.(text, { forceVision: fv })
}

function failVoiceSession(error: string): void {
  // Invalidate stale callbacks first — a failed session must never fire
  // late finals/handlers after the error is reported.
  sessionGen += 1
  listening = false
  forceVision = false
  capturing = false
  pendingDrain = null
  clearFinishTimer()
  if (deepgramConnection) deepgramStop()
  detachNativeRecognition()
  handlers.onListeningChange?.(false)
  handlers.onInterim?.('')
  handlers.onError?.(error)
}

export function getSharedAudioContext(): AudioContext {
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

/** Cleared for the rest of the page if a keyterm-carrying connect ever fails. */
let keytermsOk = true

async function openDeepgramSocket(
  client: DeepgramClient,
  ctx: AudioContext,
  withKeyterms: boolean
): Promise<DeepgramConnection> {
  const conn = await client.listen.v1.connect({
    model: 'nova-3',
    language: 'en',
    encoding: 'linear16',
    sample_rate: String(ctx.sampleRate),
    interim_results: 'true',
    smart_format: 'true',
    punctuate: 'true',
    // 1000 is Deepgram's floor. The hold already bounds the utterance — the
    // director let go of the key — so the long tail this normally guards
    // against isn't a risk here, and the shorter window is time the set gets
    // back on every spoken command.
    utterance_end_ms: '1000',
    // Repeated `keyterm=` params. The typed field JSON-encodes an array, which
    // Deepgram would read as one nonsense term — queryParams serializes with
    // arrayFormat 'repeat', which is the shape the API wants.
    ...(withKeyterms ? { queryParams: { keyterm: DIRECTOR_KEYTERMS } } : {}),
  } as Parameters<typeof client.listen.v1.connect>[0]) as unknown as DeepgramConnection
  conn.connect()
  await Promise.race([
    conn.waitForOpen(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Deepgram open timeout')), DG_OPEN_TIMEOUT_MS)
    ),
  ])
  return conn
}

async function deepgramStart(gen: number): Promise<void> {
  const client = getOrCreateDeepgramClient()
  if (!client) return

  const ctx = getSharedAudioContext()
  let pendingConn: DeepgramConnection | null = null
  deepgramConnecting = true

  try {
    // Capture and the socket come up concurrently. When the rig is already warm
    // (XR), capture is live on the very first frame and anything spoken during
    // the handshake is buffered, so the first word is never clipped.
    const rigReady = ensureCaptureRig(ctx)
    // Report "listening" (and start buffering) as soon as the mic is live —
    // not after the socket handshake, which is the part the user can't hear.
    rigReady
      .then(() => {
        if (gen !== sessionGen || !listening) return
        capturing = true
        handlers.onListeningChange?.(true)
      })
      .catch(() => { /* the awaited Promise.all below reports the failure */ })

    const [, connection] = await Promise.all([
      rigReady,
      (async () => {
        try {
          const conn = await openDeepgramSocket(client, ctx, keytermsOk)
          pendingConn = conn
          return conn
        } catch (err) {
          // Keyterm prompting is a nice-to-have; never let it cost us voice.
          // Drop it for this and every later connect, then try once more.
          if (!keytermsOk) throw err
          console.warn('[voice] Deepgram connect failed with keyterms, retrying without:', err)
          keytermsOk = false
          const conn = await openDeepgramSocket(client, ctx, false)
          pendingConn = conn
          return conn
        }
      })(),
      ctx.state === 'suspended' ? ctx.resume() : Promise.resolve(),
    ])

    deepgramConnecting = false

    // Bail if the session was stopped while we were connecting.
    if (gen !== sessionGen) {
      try { connection.close() } catch { /* ignore */ }
      return
    }

    deepgramConnection = connection
    deepgramOpen = true
    if (listening) capturing = true
    flushPendingPcm(connection)

    connection.on('message', (message) => {
      if (gen !== sessionGen) return
      if (message.type === 'Results') {
        const alt = message.channel?.alternatives?.[0]
        if (!alt || alt.transcript === undefined) return
        const transcript = (alt.transcript as string).trim()
        if (!transcript) return
        // Buffer — never submit mid-hold (see finalSegments doc comment).
        if (message.is_final) {
          pushFinalSegment(transcript)
          handlers.onInterim?.(runningTranscript(''))
        } else {
          handlers.onInterim?.(runningTranscript(transcript))
        }
      }
      if (message.type === 'UtteranceEnd') {
        // Speech ended. If the user already released push-to-talk (grace
        // drain), close out now instead of waiting the full grace window.
        if (!listening && finishTimer) {
          const fv = forceVision
          clearFinishTimer()
          stopVoiceSession()
          emitFinalAndReset(fv)
        }
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
      if (gen !== sessionGen || connection !== deepgramConnection) return
      deepgramConnection = null
      deepgramOpen = false
      capturing = false
      if (listening) {
        // Dropped mid-hold. Saying nothing here used to strand the whole hold:
        // release found no engine attached and returned without submitting.
        console.warn('[voice] Deepgram socket closed mid-hold')
        failVoiceSession('network')
      } else if (finishTimer) {
        // Expected close after CloseStream — the tail has landed, submit now
        // rather than sitting out the rest of the grace window.
        const fv = forceVision
        clearFinishTimer()
        stopVoiceSession()
        emitFinalAndReset(fv)
      }
    })

    // The button came up mid-handshake — the buffered audio has just been
    // flushed, so finalize now.
    const drain = pendingDrain
    pendingDrain = null
    if (drain && drain.gen === sessionGen) beginDeepgramDrain(drain.gen, drain.fv)
  } catch (err) {
    console.warn('[voice] Deepgram session failed:', err)
    try { (pendingConn as DeepgramConnection | null)?.close() } catch { /* ignore */ }
    deepgramConnecting = false
    pendingDrain = null
    capturing = false
    pendingChunks = []
    pendingBytes = 0
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
  // Gate the warm graph even when the socket never came up, so a cancelled
  // press can't leave PCM piling into the pre-connect buffer.
  capturing = false
  pendingChunks = []
  pendingBytes = 0
  pendingDrain = null
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
  const fv = forceVision
  listening = false
  // Stop feeding the socket the moment the button comes up — whatever lands
  // after this is the engine's own tail, not more of the hold.
  capturing = false
  handlers.onListeningChange?.(false)
  // Keep the running transcript on screen through the drain — the words you
  // just said shouldn't vanish the instant you release the button.
  handlers.onInterim?.(runningTranscript(''))

  if (deepgramConnection) {
    beginDeepgramDrain(gen, fv)
    return
  }

  if (deepgramConnecting) {
    // Released before the handshake landed. The audio is buffered — drain as
    // soon as the socket is up rather than throwing the hold away.
    pendingDrain = { gen, fv }
    return
  }

  if (recognition) {
    const rec = recognition
    clearFinishTimer()
    // Ask the engine to stop WITHOUT detaching handlers first — Chrome
    // flushes one last final onresult (whatever you were mid-saying) before
    // firing onend, and that handler (above) does the graceful submit. This
    // backstop only covers onend never firing.
    try { rec.stop() } catch { /* already stopped */ }
    finishTimer = setTimeout(() => {
      if (gen !== sessionGen) return
      if (recognition === rec) detachNativeRecognition()
      stopVoiceSession()
      emitFinalAndReset(fv)
    }, NATIVE_STOP_GRACE_MS)
    return
  }

  // No engine attached — the socket dropped while the button was held. Every
  // hold gets exactly one outcome, so submit what was captured (an empty
  // transcript reads downstream as "didn't catch that"); never end in silence.
  stopVoiceSession()
  emitFinalAndReset(fv)
}

export async function startVoiceSession(
  next: VoiceSessionHandlers,
  opts?: { forceVision?: boolean }
): Promise<void> {
  clearFinishTimer()
  // Tear down any live or draining session. A session mid-grace-drain is
  // discarded here (hard cancel, matching a fresh press-and-hold) — only a
  // clean release drains through to a submit.
  if (recognition || deepgramConnection) stopVoiceSession()

  sessionGen += 1
  const gen = sessionGen
  handlers = next
  if (opts?.forceVision) forceVision = true
  listening = true
  finalSegments = []

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
        // Buffer — never submit mid-hold. A natural pause finalizing a
        // segment must not fire a command before you've released the button.
        if (result.isFinal) pushFinalSegment(transcript)
        else ghost += transcript
      }
      handlers.onInterim?.(runningTranscript(ghost))
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
        // Graceful finish: rec.stop() already flushed any trailing final
        // into finalSegments (onresult ran before onend) — submit now,
        // faster than waiting for the backstop timer.
        const fv = forceVision
        clearFinishTimer()
        stopVoiceSession()
        emitFinalAndReset(fv)
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
