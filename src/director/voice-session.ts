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

/**
 * How far along the mic is. `connecting` matters: opening the mic and the
 * Deepgram socket can take a beat on a cold first press, and a director who
 * sees nothing assumes the button is broken and starts talking into a mic that
 * isn't up yet.
 */
export type VoicePhase = 'idle' | 'connecting' | 'listening'

export interface VoiceSessionHandlers {
  onInterim?: (text: string) => void
  onFinal?: (text: string, opts: { forceVision: boolean }) => void
  onListeningChange?: (listening: boolean) => void
  /** Finer-grained than onListeningChange — drives "opening mic…" vs "listening". */
  onPhase?: (phase: VoicePhase) => void
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
/**
 * Segments the engine has marked final, accumulated across the whole hold.
 * Hold-to-talk contract: nothing is submitted until release — a mid-hold
 * pause finalizing a segment must not fire a command early, and the words
 * must not disappear from the display while you keep talking. Reset only at
 * the top of startVoiceSession; a hard stop leaves it for the next start to
 * clear, so a graceful finish that reads-then-stops is never raced.
 */
let finalSegments: string[] = []
/**
 * Set between release and submit, while the engine flushes whatever it heard
 * last. Whichever signal arrives first — the socket closing, an UtteranceEnd,
 * the native engine's onend, or the backstop timer — settles it exactly once.
 */
let drain: { gen: number; forceVision: boolean } | null = null

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
/** Backstop only — rec.stop() -> onend normally resolves in well under this. */
const NATIVE_STOP_GRACE_MS = 800

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

/**
 * End a released session and submit what was heard. Idempotent and
 * generation-guarded, so the four racing "the engine is done" signals can all
 * call it and only the first one lands.
 */
function settleDrain(): void {
  const pending = drain
  if (!pending || pending.gen !== sessionGen) return
  drain = null
  clearFinishTimer()
  stopVoiceSession()
  emitFinalAndReset(pending.forceVision)
}

function failVoiceSession(error: string): void {
  // Invalidate stale callbacks first — a failed session must never fire
  // late finals/handlers after the error is reported.
  sessionGen += 1
  listening = false
  forceVision = false
  drain = null
  finalSegments = []
  clearFinishTimer()
  stopLevelMeter()
  if (deepgramConnection) deepgramStop()
  detachNativeRecognition()
  handlers.onListeningChange?.(false)
  handlers.onPhase?.('idle')
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

async function deepgramStart(gen: number): Promise<void> {
  const client = getOrCreateDeepgramClient()
  if (!client) return

  // Announce the press immediately. Mic + socket can take a beat on a cold
  // start; the caller lights its indicator now and swaps it to "listening"
  // below, so the button never feels dead under the finger.
  handlers.onListeningChange?.(true)
  handlers.onPhase?.('connecting')

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
        // Buffer — never submit mid-hold (see finalSegments doc comment).
        if (message.is_final) {
          pushFinalSegment(transcript)
          handlers.onInterim?.(runningTranscript(''))
        } else {
          handlers.onInterim?.(runningTranscript(transcript))
        }
      }
      if (message.type === 'UtteranceEnd') {
        // Speech ended. If the user already released push-to-talk, close out
        // now instead of waiting the full grace window.
        settleDrain()
      }
      if (message.type === 'Error') {
        console.warn('[voice] Deepgram error:', message.description)
        // Mid-drain, whatever we already transcribed still deserves to run —
        // losing the command is worse than losing the last half-word.
        if (drain) settleDrain()
        else failVoiceSession('network')
      }
    })

    connection.on('error', () => {
      if (gen !== sessionGen) return
      console.warn('[voice] Deepgram connection error')
      if (drain) settleDrain()
      else failVoiceSession('network')
    })

    connection.on('close', () => {
      if (gen !== sessionGen) return
      // Deepgram answers CloseStream by flushing its last finals and hanging
      // up. That close IS the "engine is done" signal on the normal release
      // path — UtteranceEnd only fires after a full silence window, which a
      // director who releases the button the moment they stop talking never
      // produces. Settling here is what keeps those commands from being
      // dropped on the floor.
      if (drain) {
        settleDrain()
        return
      }
      if (connection === deepgramConnection) deepgramStop()
      // Closed while still held: the mic is dead and nothing more will be
      // heard, so say so rather than let the user keep talking to nothing.
      if (listening) failVoiceSession('network')
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
    handlers.onPhase?.('listening')
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

// ---- live level (native path) ----

/**
 * Chrome's SpeechRecognition owns its own capture and hands back no audio, so
 * the UI would have nothing to react to on the desktop path. A parallel
 * analyser tap gives both engines the same live level, which is what lets the
 * pod visibly breathe with the director's voice instead of just sitting lit.
 */
let levelStream: MediaStream | null = null
let levelSource: MediaStreamAudioSourceNode | null = null
let levelRaf: number | null = null

function stopLevelMeter(): void {
  if (levelRaf !== null) {
    cancelAnimationFrame(levelRaf)
    levelRaf = null
  }
  try { levelSource?.disconnect() } catch { /* ignore */ }
  levelSource = null
  for (const track of levelStream?.getTracks() ?? []) track.stop()
  levelStream = null
}

async function startLevelMeter(gen: number): Promise<void> {
  if (!handlers.onLevel) return
  try {
    const stream = await getMicStream()
    if (gen !== sessionGen) {
      for (const track of stream.getTracks()) track.stop()
      return
    }
    const ctx = getSharedAudioContext()
    if (ctx.state === 'suspended') await ctx.resume()
    if (gen !== sessionGen) {
      for (const track of stream.getTracks()) track.stop()
      return
    }
    levelStream = stream
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.6
    const source = ctx.createMediaStreamSource(stream)
    source.connect(analyser)
    levelSource = source
    const samples = new Float32Array(analyser.fftSize)
    const tick = () => {
      if (gen !== sessionGen) return
      analyser.getFloatTimeDomainData(samples)
      let sumSq = 0
      for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i]
      handlers.onLevel?.(Math.sqrt(sumSq / samples.length))
      levelRaf = requestAnimationFrame(tick)
    }
    levelRaf = requestAnimationFrame(tick)
  } catch {
    // No level meter is a cosmetic loss — recognition itself is unaffected.
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

/**
 * Turn an engine error code into something a director can act on. Raw codes
 * ('not-allowed', 'language-not-supported') tell the user nothing and read
 * like a crash; every one of these has a next step in it instead.
 */
export function describeVoiceError(error: string): string {
  switch (error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'mic blocked — allow microphone access, then press the mic again'
    case 'network':
      return 'voice needs a connection — check the network and try again'
    case 'language-not-supported':
    case 'aborted':
      return 'the mic needs a moment — press it again'
    default:
      return error.includes(' ') ? error : 'voice is unavailable right now — you can still type a cue'
  }
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

/**
 * Pay the one-time costs of the Deepgram capture path — AudioContext startup
 * and AudioWorklet module compile — ahead of the first press, so the mic opens
 * on the beat instead of after it. Safe to call repeatedly; touches no mic and
 * asks for no permission. Must run inside a user gesture for the context to
 * actually resume.
 */
export function warmVoicePipeline(): void {
  if (!isDeepgramAvailable()) return
  try {
    const ctx = getSharedAudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    void ensurePcmCaptureWorklet(ctx)
  } catch {
    // Warming is best-effort — a cold start still works, just slower.
  }
}

export function stopVoiceSession(): void {
  listening = false
  forceVision = false
  drain = null
  clearFinishTimer()
  sessionGen += 1

  stopLevelMeter()
  if (deepgramConnection) deepgramStop()
  detachNativeRecognition()

  handlers.onListeningChange?.(false)
  handlers.onPhase?.('idle')
  handlers.onInterim?.('')
}

export function finishVoiceSession(): void {
  if (!listening) return
  listening = false
  handlers.onListeningChange?.(false)
  handlers.onPhase?.('idle')
  // Keep the running transcript on screen through the drain — the words you
  // just said shouldn't vanish the instant you release the button.
  handlers.onInterim?.(runningTranscript(''))

  if (deepgramConnection) {
    drain = { gen: sessionGen, forceVision }
    try { deepgramConnection.sendCloseStream({ type: 'CloseStream' }) } catch { /* ignore */ }
    clearFinishTimer()
    // Backstop only — the socket's close (or an UtteranceEnd) normally
    // settles this within a few hundred ms.
    finishTimer = setTimeout(settleDrain, FINISH_GRACE_MS)
    return
  }

  if (recognition) {
    drain = { gen: sessionGen, forceVision }
    clearFinishTimer()
    // Ask the engine to stop WITHOUT detaching handlers first — Chrome
    // flushes one last final onresult (whatever you were mid-saying) before
    // firing onend, and that handler settles the drain. This backstop only
    // covers onend never firing.
    try { recognition.stop() } catch { /* already stopped */ }
    finishTimer = setTimeout(settleDrain, NATIVE_STOP_GRACE_MS)
    return
  }

  // Nothing was ever capturing — settle immediately rather than stranding the
  // caller in a listening state that no engine will ever end.
  drain = { gen: sessionGen, forceVision }
  settleDrain()
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
  forceVision = opts?.forceVision ?? false
  listening = true
  drain = null
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
        settleDrain()
        return
      }
      // Chrome auto-ends on silence — restart while the mic is held open.
      try { rec.start() } catch { failVoiceSession('network') }
    }

    recognition = rec
    handlers.onListeningChange?.(true)
    handlers.onPhase?.('listening')
    handlers.onInterim?.('')
    void startLevelMeter(gen)
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
