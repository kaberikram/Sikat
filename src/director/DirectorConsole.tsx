/**
 * DIRECTOR_LINK: floating console in the viewport. Shows agent activity,
 * connection status, and takes typed (or spoken, where supported) directions.
 */
import React, { useEffect, useRef, useState } from 'react'
import { Mic } from 'lucide-react'
import { getDirectorSocket, type SocketStatus } from './socket'
import { startSceneStateSync } from './scene-state-sync'
import { applyCommandPacket } from './command-applier'

interface LogEntry {
  id: number
  source: string
  text: string
  level: 'info' | 'warn' | 'error'
}

const MAX_LOG = 40
let logCounter = 0

const STATUS_COLORS: Record<SocketStatus, string> = {
  open: '#30d158',
  connecting: '#ffd60a',
  closed: '#ff3b30',
}

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

export const DirectorConsole: React.FC = () => {
  const [status, setStatus] = useState<SocketStatus>('closed')
  const [log, setLog] = useState<LogEntry[]>([])
  const [input, setInput] = useState('')
  const [listening, setListening] = useState(false)
  const logEndRef = useRef<HTMLDivElement>(null)
  const speechAvailable = getSpeechRecognition() !== null

  const pushLog = (source: string, text: string, level: LogEntry['level'] = 'info') => {
    setLog((prev) => [...prev.slice(-(MAX_LOG - 1)), { id: ++logCounter, source, text, level }])
  }

  useEffect(() => {
    const socket = getDirectorSocket()
    const offStatus = socket.onStatus(setStatus)
    const offPacket = socket.onPacket((packet) => {
      try {
        const result = applyCommandPacket(packet)
        pushLog(packet.target_agent, `${packet.command}: ${result}`)
      } catch (e) {
        pushLog(packet.target_agent, `${packet.command} failed: ${e instanceof Error ? e.message : e}`, 'error')
      }
    })
    const offLog = socket.onLog((msg) => pushLog(msg.agent, msg.message, msg.level))
    const offError = socket.onError((msg) => pushLog('SERVER', msg.message, 'error'))
    startSceneStateSync(socket)
    socket.connect()
    setStatus(socket.status)
    return () => {
      offStatus()
      offPacket()
      offLog()
      offError()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [log])

  const submit = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
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
    <div
      className="z-20 border-4 border-black bg-white brutalist-shadow flex flex-col"
      style={{
        position: 'absolute',
        left: '16px',
        bottom: '16px',
        width: '340px',
        maxWidth: '46vw',
      }}
    >
      <div className="flex items-center gap-2 px-2 py-1 bg-black text-white text-[9px] font-mono select-none">
        <span
          className="inline-block w-2 h-2 rounded-full shrink-0"
          style={{ background: STATUS_COLORS[status] }}
          title={status}
        />
        <span className="font-bold tracking-wider flex-1">DIRECTOR_LINK</span>
        <span className="opacity-60 uppercase">{status}</span>
      </div>

      <div className="h-28 overflow-y-auto px-2 py-1 text-[9px] font-mono leading-tight bg-white">
        {log.length === 0 ? (
          <div className="opacity-40 italic">
            awaiting direction — try "add a red box" or "dim the lights"
          </div>
        ) : (
          log.map((entry) => (
            <div
              key={entry.id}
              className={
                entry.level === 'error'
                  ? 'text-red-600'
                  : entry.level === 'warn'
                    ? 'text-amber-600'
                    : entry.source === 'DIRECTOR'
                      ? 'font-bold'
                      : ''
              }
            >
              <span className="opacity-50">[{entry.source}]</span> {entry.text}
            </div>
          ))
        )}
        <div ref={logEndRef} />
      </div>

      <form
        className="flex border-t-2 border-black"
        onSubmit={(e) => {
          e.preventDefault()
          submit(input)
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={listening ? 'listening…' : 'direct the scene…'}
          className="flex-1 px-2 py-1 text-[10px] font-mono outline-none min-w-0"
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
    </div>
  )
}
