import React, { useState, useCallback, useRef } from 'react'
import { Mic, Plus, X } from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import { getDirectorSocket, type SocketStatus } from './socket'
import type { AgentQuestionMessage, AgentSuggestionMessage, PlanUpdateMessage } from './protocol'
import { startSceneStateSync } from './scene-state-sync'
import {
  enqueuePacket,
  cancelCommand,
  markAgentActive,
  markAgentIdle,
  markAgentWaiting,
  releaseWaitingAgents,
  applyIntentPreview,
  reactToSuggestion,
  releaseCommandPresence,
  setRuntimeLogger,
} from './agent-runtime'
import { activeAgentSessionId, clearAgentSession, startAgentToolExecutor } from './agent-tools'
import { currentDemoHint } from './demo-shoot'
import { isSoundEnabled, setSoundEnabled } from './sound'
import { submitDirectorCommand } from './director-command'
import { newCommandId } from './ids'
import { markFirstPacket, formatLatencySummary } from './latency'
import { presenceStore } from './presence'
import { startTakeRecorder } from './take-recorder'
import {
  finishVoiceSession,
  isSpeechAvailable,
  isVoiceListening,
  startVoiceSession,
  stopVoiceSession,
} from './voice-session'
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

interface PlanProgress {
  commandId: string
  say: string | null
  mode: PlanUpdateMessage['mode']
  status: PlanUpdateMessage['status']
  stepIndex: number | null
  stepsTotal: number | null
  stepLabel: string | null
}

const MAX_LOG = 40
const COMMAND_INPUT_TIMEOUT_MS = 30_000
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

/**
 * Transport readouts live in tiny children so their per-frame currentTime
 * subscription doesn't reconcile the whole pod (incl. the log list) at 60fps
 * during playback.
 */
function RecReadout({ takeNumber }: { takeNumber: number }) {
  const currentTime = useEditorStore((s) => s.currentTime)
  const takeStartTime = useEditorStore((s) => s.takeStartTime)
  return (
    <div className="transport-readout transport-readout--rec">
      <span className="transport-dot transport-dot--rec" />
      ● TAKE {takeNumber} {(currentTime - takeStartTime).toFixed(1)}s REC
    </div>
  )
}

function PlayReadout({ onClick }: { onClick: () => void }) {
  const currentTime = useEditorStore((s) => s.currentTime)
  return (
    <button type="button" onClick={onClick} className="transport-readout">
      <span className="transport-dot" />
      {currentTime.toFixed(2)}s — PAUSE
    </button>
  )
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
  const [pendingSuggestions, setPendingSuggestions] = useState<AgentSuggestionMessage[]>([])
  const [planProgress, setPlanProgress] = useState<PlanProgress | null>(null)
  const [isProcessingCommand, setIsProcessingCommand] = useState(false)
  /** Latest direct director answer (or miss) — legible at a glance, not buried in the log. */
  const [directorLine, setDirectorLine] = useState<{ text: string; kind: 'reply' | 'miss' } | null>(null)
  const [soundOn, setSoundOn] = useState(isSoundEnabled())
  const suggestionExpiryRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const pendingCommandIdsRef = useRef(new Set<string>())
  const pendingCommandTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const packetsByCommandRef = useRef(new Map<string, number>())

  const selectedId = useEditorStore((s) => s.selectedId)
  const isPlaying = useEditorStore((s) => s.isPlaying)
  const isRolling = useEditorStore((s) => s.isRolling)
  const takeNumber = useEditorStore((s) => s.takeNumber)
  const cameraOpMode = useEditorStore((s) => s.cameraOpMode)
  const setOverlay = useEditorStore((s) => s.setOverlay)
  const togglePlay = useEditorStore((s) => s.togglePlay)
  const setSelected = useEditorStore((s) => s.setSelected)
  const setCameraOpMode = useEditorStore((s) => s.setCameraOpMode)

  const stopMicRef = useRef<() => void>(() => {})

  const socketConfigured = getDirectorSocket().isConfigured
  const speechAvailable = isSpeechAvailable()
  const hasContext = selectedId !== null

  const pushLog = useCallback((source: string, text: string, level: LogEntry['level'] = 'info') => {
    setLog((prev) => [
      ...prev.slice(-(MAX_LOG - 1)),
      { id: ++logCounter, source, text, level, createdAt: Date.now() },
    ])
  }, [])

  const completeCommand = useCallback((commandId: string) => {
    const timer = pendingCommandTimersRef.current.get(commandId)
    if (timer) clearTimeout(timer)
    pendingCommandTimersRef.current.delete(commandId)
    pendingCommandIdsRef.current.delete(commandId)
    setPlanProgress((progress) => progress?.commandId === commandId ? null : progress)
    setIsProcessingCommand(pendingCommandIdsRef.current.size > 0)
  }, [])

  const trackCommand = useCallback((commandId: string) => {
    pendingCommandIdsRef.current.add(commandId)
    setIsProcessingCommand(true)
    const previousTimer = pendingCommandTimersRef.current.get(commandId)
    if (previousTimer) clearTimeout(previousTimer)
    const timer = setTimeout(() => completeCommand(commandId), COMMAND_INPUT_TIMEOUT_MS)
    pendingCommandTimersRef.current.set(commandId, timer)
  }, [completeCommand])

  useMountEffect(() => {
    const socket = getDirectorSocket()
    const offStatus = socket.onStatus(setStatus)
    // Packets no longer apply on arrival — the agent runtime queues them and
    // paces each apply behind its cursor's flight, logging as it commits.
    setRuntimeLogger(pushLog)
    const offPacket = socket.onPacket((packet) => {
      setPendingQuestion(null)
      if (packet.commandId) {
        packetsByCommandRef.current.set(
          packet.commandId,
          (packetsByCommandRef.current.get(packet.commandId) || 0) + 1
        )
      }
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
      releaseCommandPresence(msg.commandId)
      completeCommand(msg.commandId)
      pushLog('SYSTEM', `cancelled ${msg.commandId}${msg.reason ? ` (${msg.reason})` : ''}`, 'info')
    })
    const offQuestion = socket.onQuestion((msg) => {
      setPendingQuestion(msg)
      markAgentActive(msg.agent, msg.question, msg.commandId)
    })
    const offSuggestion = socket.onSuggestion((msg) => {
      reactToSuggestion(msg)
      if (msg.kind === 'reaction') {
        pushLog(msg.agent, msg.text)
        return
      }
      setPendingSuggestions((current) => [...current.filter((item) => item.suggestionId !== msg.suggestionId), msg].slice(-3))
      pushLog(msg.agent, msg.text)
      const timer = suggestionExpiryRef.current.get(msg.suggestionId)
      if (timer) clearTimeout(timer)
      suggestionExpiryRef.current.set(msg.suggestionId, setTimeout(() => {
        setPendingSuggestions((current) => current.filter((item) => item.suggestionId !== msg.suggestionId))
        suggestionExpiryRef.current.delete(msg.suggestionId)
      }, 25_000))
    })
    const offToolUse = startAgentToolExecutor(socket)
    const offPlanUpdate = socket.onPlanUpdate((msg) => {
      if (msg.status === 'done') {
        clearAgentSession(msg.commandId)
        setPlanProgress(null)
        return
      }
      setPlanProgress({
        commandId: msg.commandId,
        say: msg.say ?? null,
        mode: msg.mode ?? null,
        status: msg.status,
        stepIndex: msg.stepIndex ?? null,
        stepsTotal: msg.stepsTotal ?? null,
        stepLabel: msg.stepLabel ?? null,
      })
    })
    const offAgentStatus = socket.onAgentStatus((msg) => {
      if (msg.status === 'active') {
        if (msg.agent !== 'Producer') markAgentActive(msg.agent, msg.note, msg.forCommandId)
        else if (msg.note) pushLog('PRODUCER', msg.note)
      } else if (msg.agent !== 'Producer') {
        // Mid-command idle = this specialist finished a grammar batch; LLM may
        // still be directing. Only retain a spinner before local choreography
        // starts; packet queues own their own flying → done → fade lifecycle.
        const stillOpen = pendingCommandIdsRef.current.size > 0
        const p = presenceStore.getState().agents[msg.agent]
        const phase = p?.phase
        const hasStartedChoreography =
          phase === 'flying' || phase === 'working' || phase === 'settling' || phase === 'done'
        const alreadyOff = !p?.active || p.idleMode === 'faded' || phase === 'idle'
        if (stillOpen && !hasStartedChoreography && !alreadyOff) markAgentWaiting(msg.agent)
        else markAgentIdle(msg.agent)
      } else if (msg.forCommandId) {
        // Producer idle is the authoritative command-complete signal. Release
        // the preview-named agent too; markAgentIdle defers the fade if its
        // local packet queue is still settling.
        const packetCount = packetsByCommandRef.current.get(msg.forCommandId) || 0
        if (packetCount === 0) {
          pushLog(
            'PRODUCER',
            msg.note ? `no changes — ${msg.note}` : 'no changes — plan produced nothing',
            'warn'
          )
        }
        packetsByCommandRef.current.delete(msg.forCommandId)
        releaseCommandPresence(msg.forCommandId)
        completeCommand(msg.forCommandId)
        // Drop any other specialist left thinking by the same hybrid command.
        releaseWaitingAgents()
      }
    })
    const offLog = socket.onLog((msg) => {
      if (msg.kind === 'miss') {
        setDirectorLine({ text: 'didn’t catch that — name an object or a move', kind: 'miss' })
      } else if (
        (msg.kind === 'reply' || msg.agent === 'DirectorsAssistant') &&
        msg.level === 'info' &&
        msg.forCommandId
      ) {
        setDirectorLine({ text: msg.message, kind: 'reply' })
      }
      if (isBlockedCrewLog(msg.message)) return
      pushLog(msg.agent, msg.message, msg.level)
    })
    const offError = socket.onError((msg) => {
      if (msg.forCommandId) {
        releaseCommandPresence(msg.forCommandId)
        completeCommand(msg.forCommandId)
      }
      pushLog('SERVER', msg.message, 'error')
    })
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
        // While immersive, XR A-button / session end owns the mic singleton —
        // Escape must not hard-stop PTT mid-hold.
        if (!useEditorStore.getState().xrActive) stopMicRef.current()
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
      offToolUse()
      offPlanUpdate()
      offAgentStatus()
      offLog()
      offError()
      setRuntimeLogger(() => {})
      window.clearInterval(placeholderTimer)
      window.removeEventListener('keydown', onKeyDown)
      stopTakeRecorder()
      stopMicRef.current() // tear down any live mic on unmount
      for (const timer of suggestionExpiryRef.current.values()) clearTimeout(timer)
      suggestionExpiryRef.current.clear()
      for (const timer of pendingCommandTimersRef.current.values()) clearTimeout(timer)
      pendingCommandTimersRef.current.clear()
      pendingCommandIdsRef.current.clear()
    }
  })

  const submit = useCallback(async (
    text: string,
    opts?: { forceVision?: boolean; commandId?: string }
  ) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const commandId = opts?.commandId ?? newCommandId()
    setInput('')
    setDirectorLine(null)
    trackCommand(commandId)
    try {
      const result = await submitDirectorCommand(trimmed, {
        ...opts,
        commandId,
        log: pushLog,
      })
      if (!result.ok || result.local) completeCommand(commandId)
    } catch (error) {
      completeCommand(commandId)
      pushLog(
        'DIRECTOR',
        error instanceof Error ? error.message : 'command submission failed',
        'error'
      )
    }
  }, [completeCommand, pushLog, trackCommand])

  const stopMic = useCallback(() => {
    stopVoiceSession()
    setListening(false)
    setInterim('')
  }, [])
  stopMicRef.current = stopMic

  const voiceHandlers = useCallback(() => ({
    onInterim: setInterim,
    onListeningChange: setListening,
    onError: (error: string) => pushLog('DIRECTOR', `voice error: ${error}`, 'error'),
    onFinal: (transcript: string, opts: { forceVision: boolean }) => {
      void submit(transcript, { forceVision: opts.forceVision })
    },
  }), [submit, pushLog])

  const startMic = useCallback((opts?: { forceVision?: boolean }) => {
    void startVoiceSession(voiceHandlers(), opts).catch((error) => {
      pushLog('DIRECTOR', `voice failed to start: ${error instanceof Error ? error.message : error}`, 'error')
    })
  }, [voiceHandlers, pushLog])

  // Toggle-off finishes gracefully (waits for the trailing final transcript);
  // Escape/unmount use stopMic for a hard teardown.
  const toggleMic = (forceVision = false) =>
    isVoiceListening() ? finishVoiceSession() : startMic({ forceVision })

  return (
    <div className="director-pod-anchor">
      {cameraOpMode && (
        <div className="transport-readout transport-readout--cam-op">
          CAM OP — WASD · Q/E · drag look · C off
        </div>
      )}
      {isRolling && <RecReadout takeNumber={takeNumber} />}
      {isPlaying && !isRolling && <PlayReadout onClick={togglePlay} />}

      <motion.div
        layout
        className="director-pod relative z-30 rounded-[var(--radius-panel)] ring-1 ring-line bg-card/90 backdrop-blur-xl shadow-[var(--shadow-soft)]"
        transition={{ type: 'spring', stiffness: 420, damping: 36 }}
      >
        {menuOpen && (
          <div className="absolute bottom-full left-0 mb-2 bg-card rounded-[var(--radius-card)] ring-1 ring-line shadow-[var(--shadow-lift)] overflow-hidden min-w-[150px] z-40 p-1">
            {OVERLAY_COMMANDS.map((cmd) => (
              <button
                key={cmd.key}
                type="button"
                className="block w-full text-left px-2.5 py-1.5 text-[11px] font-semibold rounded-[10px] hover:bg-candy-sun/60 transition-colors"
                onClick={() => { setOverlay(cmd.key); setMenuOpen(false) }}
              >
                {cmd.label} ({cmd.hotkey.toUpperCase()})
              </button>
            ))}
            <button
              type="button"
              className="block w-full text-left px-2.5 py-1.5 text-[11px] font-semibold rounded-[10px] hover:bg-candy-sun/60 transition-colors"
              onClick={() => { setSoundEnabled(!soundOn); setSoundOn(!soundOn) }}
            >
              Sound {soundOn ? 'ON' : 'OFF'}
            </button>
          </div>
        )}
        <div className="rounded-[var(--radius-panel)] overflow-hidden flex flex-col">
        <AnimatePresence initial={false}>
          {hasContext && (
            <motion.div
              key="context"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 420, damping: 36 }}
              className="overflow-hidden border-b border-line"
            >
              <div className="px-3 py-2 bg-candy-pink/30">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-semibold text-ink-soft">Context</span>
                  <button
                    type="button"
                    onClick={() => setSelected(null)}
                    className="p-0.5 rounded-full hover:bg-[rgba(59,58,72,0.08)] transition-colors"
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
          className={`max-h-24 overflow-y-auto px-3 py-1.5 text-[10px] font-mono leading-tight director-log-panel${logHovered ? ' director-log-panel--paused' : ''}`}
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

        <div className="flex items-center gap-2 px-3 py-1 bg-ink text-white text-[10px] font-mono select-none">
          <span
            className="inline-block w-2 h-2 rounded-full shrink-0"
            style={{ background: STATUS_COLORS[status] }}
            title={status}
          />
          <span className="font-bold tracking-wider flex-1">DIRECTOR_LINK</span>
          <span className="opacity-60 uppercase">{status}</span>
        </div>

        {!socketConfigured && (
          <div className="px-3 py-1.5 border-t border-line bg-rec/15 text-[10px] font-mono font-bold text-rec">
            SERVER NOT CONFIGURED — set VITE_DIRECTOR_WS_URL (wss://…/ws) and redeploy
          </div>
        )}

        {planProgress && (
          <div className="px-3 py-1.5 border-t border-line bg-candy-blue/30 text-[10px] font-mono">
            <div className="flex items-center gap-1.5">
              {activeAgentSessionId() === planProgress.commandId && (
                <span className="px-1.5 rounded-full bg-ink text-white font-bold">AGENT</span>
              )}
              <span className="font-bold flex-1">{planProgress.say ?? 'planning the take…'}</span>
              {activeAgentSessionId() === planProgress.commandId && (
                <button
                  type="button"
                  className="px-2 rounded-full bg-white/80 font-bold shadow-[var(--shadow-chip)] hover:bg-rec hover:text-white transition-colors"
                  onClick={() => {
                    getDirectorSocket().sendAgentAbort(planProgress.commandId)
                    clearAgentSession(planProgress.commandId)
                    setPlanProgress(null)
                    pushLog('DIRECTOR', 'agent stopped', 'info')
                  }}
                >
                  STOP
                </button>
              )}
            </div>
            <div className="opacity-70 uppercase">
              {planProgress.stepIndex ?? 0}/{planProgress.stepsTotal ?? '…'} · {planProgress.stepLabel ?? planProgress.status}
            </div>
          </div>
        )}

        {pendingSuggestions.map((pendingSuggestion) => (
          <div key={pendingSuggestion.suggestionId} className="px-3 py-2 border-t border-line bg-candy-sun/40">
            <p className="text-[11px] font-semibold mb-1.5">
              [{pendingSuggestion.agent}] {pendingSuggestion.text}
            </p>
            <div className="flex flex-wrap gap-1">
              {pendingSuggestion.suggestedCommand && (
                <button
                  type="button"
                  className="px-2.5 py-0.5 text-[11px] font-semibold rounded-full bg-white/85 shadow-[var(--shadow-chip)] hover:bg-ink hover:text-white transition-colors"
                  onClick={() => {
                    const cmd = pendingSuggestion.suggestedCommand
                    setPendingSuggestions((current) => current.filter((item) => item.suggestionId !== pendingSuggestion.suggestionId))
                    const timer = suggestionExpiryRef.current.get(pendingSuggestion.suggestionId)
                    if (timer) clearTimeout(timer)
                    suggestionExpiryRef.current.delete(pendingSuggestion.suggestionId)
                    if (cmd) void submit(cmd)
                  }}
                >
                  DO IT
                </button>
              )}
              <button
                type="button"
                className="px-2.5 py-0.5 text-[11px] font-semibold rounded-full bg-white/85 shadow-[var(--shadow-chip)] hover:bg-ink hover:text-white transition-colors"
                onClick={() => {
                  setPendingSuggestions((current) => current.filter((item) => item.suggestionId !== pendingSuggestion.suggestionId))
                  const timer = suggestionExpiryRef.current.get(pendingSuggestion.suggestionId)
                  if (timer) clearTimeout(timer)
                  suggestionExpiryRef.current.delete(pendingSuggestion.suggestionId)
                }}
              >
                DISMISS
              </button>
            </div>
          </div>
        ))}

        {pendingQuestion && (
          <div className="px-3 py-2 border-t border-line bg-candy-sun/30">
            <p className="text-[11px] font-semibold mb-1.5">
              [{pendingQuestion.agent}] {pendingQuestion.question}
            </p>
            <div className="flex flex-wrap gap-1">
              {pendingQuestion.options.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className="px-2.5 py-0.5 text-[11px] font-semibold rounded-full bg-white/85 shadow-[var(--shadow-chip)] hover:bg-ink hover:text-white transition-colors"
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

        {directorLine && !listening && (
          <div className="flex items-center gap-2 px-3 py-1.5 border-t border-line text-[11px]">
            <span
              className="shrink-0 w-1.5 h-1.5 rounded-full"
              style={{ background: directorLine.kind === 'miss' ? '#F27BAC' : '#57CFA0' }}
            />
            <span className={directorLine.kind === 'miss' ? 'text-ink-soft' : 'font-semibold'}>
              {directorLine.text}
            </span>
          </div>
        )}

        <form
          className="flex items-stretch border-t border-line"
          aria-busy={isProcessingCommand}
          onSubmit={(e) => {
            e.preventDefault()
            submit(input)
          }}
        >
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            title="Summon panels"
            aria-expanded={menuOpen}
            className="shrink-0 px-2.5 py-1 border-r border-line bg-candy-sun hover:bg-candy-sun-deep transition-colors"
          >
            <Plus size={12} />
          </button>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              interim ||
              (listening
                ? 'listening…'
                : isProcessingCommand
                  ? 'crew is working…'
                  : currentDemoHint() ?? PLACEHOLDERS[placeholderIdx])
            }
            className="flex-1 px-3 py-2 text-[11px] font-sans bg-transparent placeholder:text-ink-soft outline-none min-w-0"
          />
          {speechAvailable && (
            <button
              type="button"
              onClick={(e) => toggleMic(e.shiftKey)}
              title={listening ? 'Stop voice direction (Esc)' : 'Live voice direction (Shift+click to attach viewfinder)'}
              aria-pressed={listening}
              className={`px-2.5 border-l border-line transition-colors ${listening ? 'bg-rec text-white animate-pulse' : 'bg-transparent hover:bg-[rgba(59,58,72,0.06)]'}`}
            >
              <Mic size={12} />
            </button>
          )}
          <button
            type="submit"
            className="px-4 py-1 bg-ink text-white text-[11px] font-semibold hover:bg-candy-sun-deep hover:text-ink border-l border-line transition-colors"
          >
            SEND
          </button>
        </form>
        </div>
      </motion.div>
    </div>
  )
}
