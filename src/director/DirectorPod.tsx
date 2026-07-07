import React, { useState, useCallback, useRef } from 'react'
import { Mic, Plus, X } from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import { getDirectorSocket, type SocketStatus } from './socket'
import type { AgentQuestionMessage, AgentSuggestionMessage } from './protocol'
import { startSceneStateSync } from './scene-state-sync'
import {
  enqueuePacket,
  cancelCommand,
  markAgentActive,
  markAgentIdle,
  applyClientIntentGuess,
  applyIntentPreview,
  idleGuessedAgent,
  reactToSuggestion,
  setRuntimeLogger,
} from './agent-runtime'
import { tryLocalCommand } from './local-commands'
import { markCommandSent, markFirstPacket, formatLatencySummary } from './latency'
import { startTakeRecorder } from './take-recorder'
import { buildProducerReadback } from './intent-guess'
import { useMountEffect } from '../hooks/useMountEffect'
import { useEditorStore } from '../store'
import { ContextProperties } from '../ui/context-properties'
import { OVERLAY_COMMANDS, overlayFromHotkey } from '../ui/overlay-commands'

interface LogEntry {
  id: number
  source: string
  text: string
  level: 'info' | 'warn' | 'error'
  createdAt: number
}

const MAX_LOG = 40
let logCounter = 0

const STATUS_COLORS: Record<SocketStatus, string> = {
  open: '#30d158',
  connecting: '#ffd60a',
  closed: '#ff3b30',
}

const PLACEHOLDERS = [
  'add a red box then dim the lights',
  'sunset mood',
  'enable bloom',
  'move the box up 2 over 3 seconds',
  'show timeline',
]

// Instant pre-parse Producer note — rotates so back-to-back commands don't
// all flash the same word before the real per-packet note takes over.
const INSTANT_NOTES = ['copy', 'on it', 'hearing you', 'rolling on that', 'got it', 'standing by', 'yep', 'roger']
const recentStatusNotes: string[] = []
let instantNoteIdx = 0
function nextInstantNote(): string {
  const fresh = INSTANT_NOTES.filter((n) => !recentStatusNotes.includes(n))
  const pool = fresh.length > 0 ? fresh : INSTANT_NOTES
  const note = pool[instantNoteIdx % pool.length]
  instantNoteIdx += 1
  recentStatusNotes.push(note)
  if (recentStatusNotes.length > 12) recentStatusNotes.shift()
  return note
}

interface SpeechAlternativeLike {
  transcript: string
}
interface SpeechResultLike extends ArrayLike<SpeechAlternativeLike> {
  isFinal: boolean
}
interface SpeechResultEvent {
  resultIndex: number
  results: ArrayLike<SpeechResultLike>
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

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as Record<string, unknown>
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as
    | (new () => SpeechRecognitionLike)
    | null
}

const LOG_CLASS: Record<LogEntry['level'], string> = {
  info: '',
  warn: 'text-amber-600',
  error: 'text-red-600',
}

function logLineClass(entry: LogEntry): string {
  if (entry.source === 'DIRECTOR' && entry.level === 'info') return 'font-bold'
  return LOG_CLASS[entry.level]
}

const CREW_LOG_BLOCK = /defer →|grammar handled|LLM directed|assigning:|via fallback|streaming \d+ clause/i

function isBlockedCrewLog(message: string): boolean {
  return CREW_LOG_BLOCK.test(message)
}

export function DirectorPod() {
  const [status, setStatus] = useState<SocketStatus>('closed')
  const [log, setLog] = useState<LogEntry[]>([])
  const [input, setInput] = useState('')
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const [logHovered, setLogHovered] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [placeholderIdx, setPlaceholderIdx] = useState(0)
  const [pendingQuestion, setPendingQuestion] = useState<AgentQuestionMessage | null>(null)
  const [pendingSuggestion, setPendingSuggestion] = useState<AgentSuggestionMessage | null>(null)
  const suggestionExpiryRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const selectedId = useEditorStore((s) => s.selectedId)
  const isPlaying = useEditorStore((s) => s.isPlaying)
  const isRolling = useEditorStore((s) => s.isRolling)
  const takeNumber = useEditorStore((s) => s.takeNumber)
  const cameraOpMode = useEditorStore((s) => s.cameraOpMode)
  const currentTime = useEditorStore((s) => s.currentTime)
  const takeStartTime = useEditorStore((s) => s.takeStartTime)
  const setOverlay = useEditorStore((s) => s.setOverlay)
  const togglePlay = useEditorStore((s) => s.togglePlay)
  const setSelected = useEditorStore((s) => s.setSelected)
  const setCameraOpMode = useEditorStore((s) => s.setCameraOpMode)

  // Live-mic plumbing. The recognition instance persists across renders; the
  // latched flag lives in a ref so the (stale-closured) onend handler can read
  // the current state to decide whether to auto-restart.
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const listeningRef = useRef(false)
  const micVisionRef = useRef(false)
  const micGuessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stopMicRef = useRef<() => void>(() => {})

  const clearMicGuessTimer = useCallback(() => {
    if (micGuessTimerRef.current) {
      clearTimeout(micGuessTimerRef.current)
      micGuessTimerRef.current = null
    }
  }, [])

  const speechAvailable = getSpeechRecognition() !== null
  const hasContext = selectedId !== null

  const pushLog = useCallback((source: string, text: string, level: LogEntry['level'] = 'info') => {
    setLog((prev) => [
      ...prev.slice(-(MAX_LOG - 1)),
      { id: ++logCounter, source, text, level, createdAt: Date.now() },
    ])
  }, [])

  useMountEffect(() => {
    const socket = getDirectorSocket()
    const offStatus = socket.onStatus(setStatus)
    // Packets no longer apply on arrival — the agent runtime queues them and
    // paces each apply behind its cursor's flight, logging as it commits.
    setRuntimeLogger(pushLog)
    const offPacket = socket.onPacket((packet) => {
      setPendingQuestion(null)
      const elapsed = markFirstPacket(packet.commandId)
      if (elapsed != null) pushLog('SYSTEM', `⏱ first packet ${elapsed.toFixed(2)}s`)
      enqueuePacket(packet)
      const summary = formatLatencySummary(packet.commandId)
      if (summary) pushLog('SYSTEM', summary)
    })
    const offIntentPreview = socket.onIntentPreview((msg) => {
      applyIntentPreview(msg)
    })
    const offCancel = socket.onCancel((msg) => {
      cancelCommand(msg)
      pushLog('SYSTEM', `cancelled ${msg.commandId}${msg.reason ? ` (${msg.reason})` : ''}`, 'info')
    })
    const offQuestion = socket.onQuestion((msg) => {
      setPendingQuestion(msg)
      markAgentActive(msg.agent, msg.question)
    })
    const offSuggestion = socket.onSuggestion((msg) => {
      reactToSuggestion(msg)
      if (msg.kind === 'reaction') {
        pushLog(msg.agent, msg.text)
        return
      }
      if (suggestionExpiryRef.current) clearTimeout(suggestionExpiryRef.current)
      setPendingSuggestion(msg)
      pushLog(msg.agent, msg.text)
      suggestionExpiryRef.current = setTimeout(() => {
        setPendingSuggestion(null)
        suggestionExpiryRef.current = null
      }, 25_000)
    })
    const offAgentStatus = socket.onAgentStatus((msg) => {
      if (msg.note) {
        recentStatusNotes.push(msg.note)
        if (recentStatusNotes.length > 12) recentStatusNotes.shift()
      }
      if (msg.status === 'active') {
        if (msg.agent !== 'Producer') markAgentActive(msg.agent, msg.note)
        else if (msg.note) pushLog('PRODUCER', msg.note)
      } else if (msg.agent !== 'Producer') {
        markAgentIdle(msg.agent)
      }
    })
    const offLog = socket.onLog((msg) => {
      if (isBlockedCrewLog(msg.message)) return
      pushLog(msg.agent, msg.message, msg.level)
    })
    const offError = socket.onError((msg) => pushLog('SERVER', msg.message, 'error'))
    startSceneStateSync(socket)
    const stopTakeRecorder = startTakeRecorder()
    socket.connect()
    setStatus(socket.status)

    const placeholderTimer = window.setInterval(() => {
      setPlaceholderIdx((i) => (i + 1) % PLACEHOLDERS.length)
    }, 4000)

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setSelected(null)
        setMenuOpen(false)
        stopMicRef.current() // drop the live mic on Escape
        return
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const overlayKey = overlayFromHotkey(e.key)
      if (overlayKey) setOverlay(overlayKey)
      if (e.key === 'c' || e.key === 'C') {
        setCameraOpMode(!useEditorStore.getState().cameraOpMode)
        return
      }
      if (e.key === ' ') {
        e.preventDefault()
        togglePlay()
      }
    }
    window.addEventListener('keydown', onKeyDown)

    return () => {
      offStatus()
      offPacket()
      offIntentPreview()
      offCancel()
      offQuestion()
      offSuggestion()
      offAgentStatus()
      offLog()
      offError()
      setRuntimeLogger(() => {})
      window.clearInterval(placeholderTimer)
      window.removeEventListener('keydown', onKeyDown)
      stopTakeRecorder()
      stopMicRef.current() // tear down any live mic on unmount
      if (suggestionExpiryRef.current) clearTimeout(suggestionExpiryRef.current)
    }
  })

  const submit = useCallback(async (
    text: string,
    opts?: { forceVision?: boolean; commandId?: string }
  ) => {
    const trimmed = text.trim()
    if (!trimmed) return

    const local = tryLocalCommand(trimmed)
    if (local.handled) {
      pushLog('DIRECTOR', trimmed)
      if (local.message) pushLog('SYSTEM', local.message)
      setInput('')
      return
    }

    clearMicGuessTimer()
    const socket = getDirectorSocket()
    const commandId = opts?.commandId ?? crypto.randomUUID()
    const readback = buildProducerReadback(trimmed)
    pushLog('PRODUCER', readback ?? nextInstantNote())
    applyClientIntentGuess(trimmed, commandId)
    markCommandSent(commandId)

    const sent = await socket.sendUserCommand(trimmed, { ...opts, commandId })
    if (sent) {
      pushLog('DIRECTOR', trimmed)
      setInput('')
    } else {
      idleGuessedAgent(commandId)
      pushLog('DIRECTOR', 'not connected — command dropped', 'error')
    }
  }, [pushLog, clearMicGuessTimer])

  const stopMic = useCallback(() => {
    clearMicGuessTimer()
    listeningRef.current = false
    micVisionRef.current = false
    setListening(false)
    setInterim('')
    const recognition = recognitionRef.current
    recognitionRef.current = null
    if (recognition) {
      recognition.onresult = null
      recognition.onend = null // detach before stop so it doesn't auto-restart
      recognition.onerror = null
      try {
        recognition.stop()
      } catch {
        /* already stopped */
      }
    }
  }, [clearMicGuessTimer])
  stopMicRef.current = stopMic

  const startMic = useCallback((opts?: { forceVision?: boolean }) => {
    const Recognition = getSpeechRecognition()
    if (!Recognition || listeningRef.current) return
    if (opts?.forceVision) micVisionRef.current = true
    const recognition = new Recognition()
    recognition.lang = 'en-US'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    recognition.onresult = (event) => {
      let ghost = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const transcript = result[0]?.transcript ?? ''
        if (result.isFinal) void submit(transcript, { forceVision: micVisionRef.current })
        else ghost += transcript
      }
      setInterim(ghost)
      const interim = ghost.trim()
      if (interim) {
        clearMicGuessTimer()
        micGuessTimerRef.current = setTimeout(() => {
          applyClientIntentGuess(interim)
          micGuessTimerRef.current = null
        }, 300)
      }
    }
    recognition.onerror = (event) => {
      // A denied/unavailable mic is terminal; other errors let onend restart.
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        stopMic()
      }
    }
    recognition.onend = () => {
      // Browsers end the session periodically; restart while still latched.
      if (listeningRef.current && recognitionRef.current === recognition) {
        try {
          recognition.start()
        } catch {
          stopMic()
        }
      }
    }
    recognitionRef.current = recognition
    listeningRef.current = true
    setListening(true)
    setInterim('')
    try {
      recognition.start()
    } catch {
      stopMic()
    }
  }, [stopMic, submit])

  const toggleMic = (forceVision = false) =>
    listeningRef.current ? stopMic() : startMic({ forceVision })

  return (
    <div className="director-pod-anchor">
      {cameraOpMode && (
        <div className="transport-readout transport-readout--cam-op">
          CAM OP — WASD · Q/E · drag look · C off
        </div>
      )}
      {isRolling && (
        <div className="transport-readout transport-readout--rec">
          <span className="transport-dot transport-dot--rec" />
          ● TAKE {takeNumber} {(currentTime - takeStartTime).toFixed(1)}s REC
        </div>
      )}
      {isPlaying && !isRolling && (
        <button
          type="button"
          onClick={togglePlay}
          className="transport-readout"
        >
          <span className="transport-dot" />
          {currentTime.toFixed(2)}s — PAUSE
        </button>
      )}

      <motion.div
        layout
        className="director-pod z-30 border-4 border-black bg-white brutalist-shadow flex flex-col"
        transition={{ type: 'spring', stiffness: 420, damping: 36 }}
      >
        <AnimatePresence initial={false}>
          {hasContext && (
            <motion.div
              key="context"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22 }}
              className="overflow-hidden border-b-2 border-black/20"
            >
              <div className="px-3 py-2 bg-[var(--jsr-pink)]/20">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[9px] font-mono font-bold uppercase opacity-60">Context</span>
                  <button
                    type="button"
                    onClick={() => setSelected(null)}
                    className="p-0.5 hover:bg-black/10"
                    title="Deselect (Esc)"
                  >
                    <X size={12} />
                  </button>
                </div>
                <ContextProperties />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div
          className={`max-h-24 overflow-y-auto px-2 py-1 text-[9px] font-mono leading-tight bg-white director-log-panel${logHovered ? ' director-log-panel--paused' : ''}`}
            onMouseEnter={() => setLogHovered(true)}
            onMouseLeave={() => setLogHovered(false)}
          >
            {log.length === 0 ? (
              <div className="opacity-40 italic">awaiting direction…</div>
            ) : (
              log.map((entry) => (
                <div key={entry.id} className={`director-log-line ${logLineClass(entry)}`}>
                  <span className="opacity-50">[{entry.source}]</span> {entry.text}
                </div>
              ))
            )}
          </div>

        <div className="flex items-center gap-2 px-2 py-1 bg-black text-white text-[9px] font-mono select-none">
          <span
            className="inline-block w-2 h-2 rounded-full shrink-0"
            style={{ background: STATUS_COLORS[status] }}
            title={status}
          />
          <span className="font-bold tracking-wider flex-1">DIRECTOR_LINK</span>
          <span className="opacity-60 uppercase">{status}</span>
        </div>

        {pendingSuggestion && (
          <div className="px-2 py-2 border-t border-black/20 bg-[var(--jsr-yellow)]/40">
            <p className="text-[9px] font-bold mb-1.5">
              [{pendingSuggestion.agent}] {pendingSuggestion.text}
            </p>
            <div className="flex flex-wrap gap-1">
              {pendingSuggestion.suggestedCommand && (
                <button
                  type="button"
                  className="px-2 py-0.5 text-[9px] font-bold border-2 border-black bg-white hover:bg-black hover:text-white"
                  onClick={() => {
                    const cmd = pendingSuggestion.suggestedCommand
                    setPendingSuggestion(null)
                    if (suggestionExpiryRef.current) {
                      clearTimeout(suggestionExpiryRef.current)
                      suggestionExpiryRef.current = null
                    }
                    if (cmd) void submit(cmd)
                  }}
                >
                  DO IT
                </button>
              )}
              <button
                type="button"
                className="px-2 py-0.5 text-[9px] font-bold border-2 border-black bg-white hover:bg-black hover:text-white"
                onClick={() => {
                  setPendingSuggestion(null)
                  if (suggestionExpiryRef.current) {
                    clearTimeout(suggestionExpiryRef.current)
                    suggestionExpiryRef.current = null
                  }
                }}
              >
                DISMISS
              </button>
            </div>
          </div>
        )}

        {pendingQuestion && (
          <div className="px-2 py-2 border-t border-black/20 bg-[var(--jsr-yellow)]/30">
            <p className="text-[9px] font-bold mb-1.5">
              [{pendingQuestion.agent}] {pendingQuestion.question}
            </p>
            <div className="flex flex-wrap gap-1">
              {pendingQuestion.options.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className="px-2 py-0.5 text-[9px] font-bold border-2 border-black bg-white hover:bg-black hover:text-white"
                  onClick={() => {
                    setPendingQuestion(null)
                    void submit(opt, { commandId: pendingQuestion.commandId })
                  }}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>
        )}

        <form
          className="flex border-t-2 border-black"
          onSubmit={(e) => {
            e.preventDefault()
            submit(input)
          }}
        >
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              title="Summon panels"
              className="px-2 py-1 border-r-2 border-black bg-[var(--jsr-yellow)] hover:bg-black hover:text-[var(--jsr-yellow)] h-full"
            >
              <Plus size={12} />
            </button>
            {menuOpen && (
              <div className="absolute bottom-full left-0 mb-1 bg-white border-2 border-black brutalist-shadow min-w-[140px] z-40">
                {OVERLAY_COMMANDS.map((cmd) => (
                  <button
                    key={cmd.key}
                    type="button"
                    className="block w-full text-left px-2 py-1 text-[9px] font-bold hover:bg-[var(--jsr-yellow)]"
                    onClick={() => { setOverlay(cmd.key); setMenuOpen(false) }}
                  >
                    {cmd.label} ({cmd.hotkey.toUpperCase()})
                  </button>
                ))}
              </div>
            )}
          </div>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={interim || (listening ? 'listening…' : PLACEHOLDERS[placeholderIdx])}
            className="flex-1 px-2 py-1.5 text-[10px] font-mono outline-none min-w-0"
          />
          {speechAvailable && (
            <button
              type="button"
              onClick={(e) => toggleMic(e.shiftKey)}
              title={listening ? 'Stop voice direction (Esc)' : 'Live voice direction (Shift+click to attach viewfinder)'}
              aria-pressed={listening}
              className={`px-2 border-l-2 border-black ${listening ? 'bg-jsr-orange text-white animate-pulse' : 'bg-white hover:bg-black/5'}`}
            >
              <Mic size={12} />
            </button>
          )}
          <button
            type="submit"
            className="px-3 py-1 bg-black text-white text-[9px] font-bold hover:bg-jsr-orange border-l-2 border-black"
          >
            SEND
          </button>
        </form>
      </motion.div>
    </div>
  )
}
