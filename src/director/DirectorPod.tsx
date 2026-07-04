import React, { useState, useCallback } from 'react'
import { Mic, Plus, X } from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import { getDirectorSocket, type SocketStatus } from './socket'
import { startSceneStateSync } from './scene-state-sync'
import {
  enqueuePacket,
  markAgentActive,
  markAgentIdle,
  setRuntimeLogger,
} from './agent-runtime'
import { tryLocalCommand } from './local-commands'
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

interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  maxAlternatives: number
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start: () => void
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

export function DirectorPod() {
  const [status, setStatus] = useState<SocketStatus>('closed')
  const [log, setLog] = useState<LogEntry[]>([])
  const [input, setInput] = useState('')
  const [listening, setListening] = useState(false)
  const [logHovered, setLogHovered] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [placeholderIdx, setPlaceholderIdx] = useState(0)

  const selectedId = useEditorStore((s) => s.selectedId)
  const isPlaying = useEditorStore((s) => s.isPlaying)
  const currentTime = useEditorStore((s) => s.currentTime)
  const setOverlay = useEditorStore((s) => s.setOverlay)
  const togglePlay = useEditorStore((s) => s.togglePlay)
  const setSelected = useEditorStore((s) => s.setSelected)

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
    const offPacket = socket.onPacket(enqueuePacket)
    const offAgentStatus = socket.onAgentStatus((msg) => {
      if (msg.status === 'active') markAgentActive(msg.agent)
      else markAgentIdle(msg.agent)
    })
    const offLog = socket.onLog((msg) => pushLog(msg.agent, msg.message, msg.level))
    const offError = socket.onError((msg) => pushLog('SERVER', msg.message, 'error'))
    startSceneStateSync(socket)
    socket.connect()
    setStatus(socket.status)

    const placeholderTimer = window.setInterval(() => {
      setPlaceholderIdx((i) => (i + 1) % PLACEHOLDERS.length)
    }, 4000)

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setSelected(null)
        setMenuOpen(false)
        return
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const overlayKey = overlayFromHotkey(e.key)
      if (overlayKey) setOverlay(overlayKey)
      if (e.key === ' ') {
        e.preventDefault()
        togglePlay()
      }
    }
    window.addEventListener('keydown', onKeyDown)

    return () => {
      offStatus()
      offPacket()
      offAgentStatus()
      offLog()
      offError()
      setRuntimeLogger(() => {})
      window.clearInterval(placeholderTimer)
      window.removeEventListener('keydown', onKeyDown)
    }
  })

  const submit = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return

    const local = tryLocalCommand(trimmed)
    if (local.handled) {
      pushLog('DIRECTOR', trimmed)
      if (local.message) pushLog('SYSTEM', local.message)
      setInput('')
      return
    }

    const socket = getDirectorSocket()
    const commandId = socket.sendUserCommand(trimmed)
    if (commandId) {
      pushLog('DIRECTOR', trimmed)
      setInput('')
    } else {
      pushLog('DIRECTOR', 'not connected — command dropped', 'error')
    }
  }

  const startListening = () => {
    const Recognition = getSpeechRecognition()
    if (!Recognition || listening) return
    const recognition = new Recognition()
    recognition.lang = 'en-US'
    recognition.interimResults = false
    recognition.maxAlternatives = 1
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript
      if (transcript) submit(transcript)
    }
    recognition.onend = () => setListening(false)
    recognition.onerror = () => setListening(false)
    setListening(true)
    recognition.start()
  }

  return (
    <div className="director-pod-anchor">
      {isPlaying && (
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
            placeholder={listening ? 'listening…' : PLACEHOLDERS[placeholderIdx]}
            className="flex-1 px-2 py-1.5 text-[10px] font-mono outline-none min-w-0"
          />
          {speechAvailable && (
            <button
              type="button"
              onClick={startListening}
              title="Voice direction"
              className={`px-2 border-l-2 border-black ${listening ? 'bg-jsr-orange text-white' : 'bg-white hover:bg-black/5'}`}
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
