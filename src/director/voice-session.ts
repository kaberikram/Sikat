/**
 * Shared Web Speech session — used by DirectorPod mic and XR push-to-talk.
 * No React; callers pass callbacks.
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
  /** Fired on interim (debounced) for client intent guess — optional. */
  onInterimGuess?: (text: string) => void
}

let recognition: SpeechRecognitionLike | null = null
let listening = false
let forceVision = false
let handlers: VoiceSessionHandlers = {}
let guessTimer: ReturnType<typeof setTimeout> | null = null

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as Record<string, unknown>
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as
    | (new () => SpeechRecognitionLike)
    | null
}

export function isSpeechAvailable(): boolean {
  return getSpeechRecognitionCtor() !== null
}

export function isVoiceListening(): boolean {
  return listening
}

function clearGuessTimer(): void {
  if (guessTimer) {
    clearTimeout(guessTimer)
    guessTimer = null
  }
}

export function stopVoiceSession(): void {
  clearGuessTimer()
  listening = false
  forceVision = false
  handlers.onListeningChange?.(false)
  handlers.onInterim?.('')
  const rec = recognition
  recognition = null
  if (rec) {
    rec.onresult = null
    rec.onend = null
    rec.onerror = null
    try {
      rec.stop()
    } catch {
      /* already stopped */
    }
  }
}

export function startVoiceSession(
  next: VoiceSessionHandlers,
  opts?: { forceVision?: boolean }
): void {
  const Recognition = getSpeechRecognitionCtor()
  if (!Recognition || listening) return

  handlers = next
  if (opts?.forceVision) forceVision = true

  const rec = new Recognition()
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
    const interim = ghost.trim()
    if (interim && handlers.onInterimGuess) {
      clearGuessTimer()
      guessTimer = setTimeout(() => {
        handlers.onInterimGuess?.(interim)
        guessTimer = null
      }, 300)
    }
  }

  rec.onerror = (event) => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      stopVoiceSession()
    }
  }

  rec.onend = () => {
    if (listening && recognition === rec) {
      try {
        rec.start()
      } catch {
        stopVoiceSession()
      }
    }
  }

  recognition = rec
  listening = true
  handlers.onListeningChange?.(true)
  handlers.onInterim?.('')
  try {
    rec.start()
  } catch {
    stopVoiceSession()
  }
}

export function toggleVoiceSession(
  next: VoiceSessionHandlers,
  opts?: { forceVision?: boolean }
): void {
  if (listening) stopVoiceSession()
  else startVoiceSession(next, opts)
}
