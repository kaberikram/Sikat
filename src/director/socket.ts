/**
 * DirectorSocket: the editor's realtime link to the agent-swarm backend.
 * Reconnects with exponential backoff (1s -> 10s cap, ±20% jitter).
 * No React imports — UI subscribes via the on* methods.
 */
import {
  type CommandPacket,
  type AgentLogMessage,
  type AgentStatusMessage,
  type AgentToolResultMessage,
  type AgentToolUseMessage,
  type AgentAbortMessage,
  type IntentPreviewMessage,
  type CommandCancelMessage,
  type AgentQuestionMessage,
  type AgentSuggestionMessage,
  type PlanUpdateMessage,
  type ErrorMessage,
  type SceneSnapshot,
  parseServerMessage,
} from './protocol'
import { retireAllCursors } from './agent-runtime'
import { newCommandId } from './ids'
import { admitToQueue, linkExpired, PING_INTERVAL_MS, pruneQueue } from './link-health'
import { buildFullSnapshot } from './scene-state-sync'
import { shouldAttachVision } from './vision-triggers'
import { captureViewfinderFrame } from './viewfinder-capture'

export type SocketStatus = 'connecting' | 'open' | 'closed'

type Listener<T> = (value: T) => void

/** A command held while the link was down, waiting to be replayed on reconnect. */
interface QueuedCommand {
  queuedAt: number
  payload: Record<string, unknown>
}

function defaultUrl(): string | null {
  const configured = import.meta.env.VITE_DIRECTOR_WS_URL as string | undefined
  if (configured) return configured
  if (typeof location === 'undefined') return 'ws://localhost:8000/ws'
  // Insecure ws:// is blocked on HTTPS pages — require VITE_DIRECTOR_WS_URL in prod.
  if (location.protocol === 'https:') return null
  return `ws://${location.hostname}:8000/ws`
}

export class DirectorSocket {
  private ws: WebSocket | null = null
  private url: string | null
  private attempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closedByUser = false
  private pingTimer: ReturnType<typeof setInterval> | null = null
  /** Timestamp of the last frame of any kind — the only honest proof of life. */
  private lastInboundAt = 0
  private outbox: QueuedCommand[] = []
  private wakeListenersBound = false

  private packetListeners = new Set<Listener<CommandPacket>>()
  private logListeners = new Set<Listener<AgentLogMessage>>()
  private agentStatusListeners = new Set<Listener<AgentStatusMessage>>()
  private intentPreviewListeners = new Set<Listener<IntentPreviewMessage>>()
  private cancelListeners = new Set<Listener<CommandCancelMessage>>()
  private questionListeners = new Set<Listener<AgentQuestionMessage>>()
  private suggestionListeners = new Set<Listener<AgentSuggestionMessage>>()
  private planUpdateListeners = new Set<Listener<PlanUpdateMessage>>()
  private toolUseListeners = new Set<Listener<AgentToolUseMessage>>()
  private errorListeners = new Set<Listener<ErrorMessage>>()
  private statusListeners = new Set<Listener<SocketStatus>>()
  private openListeners = new Set<() => void>()

  status: SocketStatus = 'closed'

  /** True once a connection has ever succeeded — distinguishes "no server
   *  in this setup" (calm LOCAL CREW mode) from "link lost" (an error). */
  everConnected = false

  constructor(url?: string | null) {
    this.url = url ?? defaultUrl()
  }

  /** False when no backend URL (e.g. HTTPS prod without VITE_DIRECTOR_WS_URL). */
  get isConfigured(): boolean {
    return Boolean(this.url)
  }

  /** Failed connection attempts so far; 0 while the first one is still open. */
  get reconnectAttempts(): number {
    return this.attempts
  }

  /** How many commands are held waiting for the link — 0 when nothing is owed. */
  get heldCommandCount(): number {
    this.outbox = pruneQueue(this.outbox, Date.now())
    return this.outbox.length
  }

  connect() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return
    if (!this.url) {
      this.setStatus('closed')
      return
    }
    this.bindWakeListeners()
    this.closedByUser = false
    this.setStatus('connecting')
    try {
      this.ws = new WebSocket(this.url)
    } catch {
      this.ws = null
      this.setStatus('closed')
      return
    }
    this.ws.onopen = () => {
      this.attempts = 0
      this.everConnected = true
      this.lastInboundAt = Date.now()
      this.startPinging()
      this.setStatus('open')
      for (const cb of this.openListeners) cb()
      this.flushOutbox()
    }
    this.ws.onmessage = (event) => {
      // Before parsing: any frame at all is proof the link is alive, including
      // a `pong` that carries no other meaning.
      this.lastInboundAt = Date.now()
      let raw: unknown
      try {
        raw = JSON.parse(event.data as string)
      } catch {
        return
      }
      const msg = parseServerMessage(raw)
      if (!msg) return
      if (msg.type === 'agent_command') for (const cb of this.packetListeners) cb(msg.packet)
      else if (msg.type === 'agent_log') for (const cb of this.logListeners) cb(msg)
      else if (msg.type === 'agent_status')
        for (const cb of this.agentStatusListeners) cb(msg)
      else if (msg.type === 'intent_preview')
        for (const cb of this.intentPreviewListeners) cb(msg)
      else if (msg.type === 'command_cancel')
        for (const cb of this.cancelListeners) cb(msg)
      else if (msg.type === 'agent_question')
        for (const cb of this.questionListeners) cb(msg)
      else if (msg.type === 'agent_suggestion')
        for (const cb of this.suggestionListeners) cb(msg)
      else if (msg.type === 'plan_update')
        for (const cb of this.planUpdateListeners) cb(msg)
      else if (msg.type === 'agent_tool_use')
        for (const cb of this.toolUseListeners) cb(msg)
      else for (const cb of this.errorListeners) cb(msg)
    }
    this.ws.onclose = () => {
      this.ws = null
      this.stopPinging()
      this.setStatus('closed')
      // Any crew choreography in flight is now orphaned — the packets that
      // would have finished it are never arriving. Retire the cursors rather
      // than leaving them lit over work that will not happen.
      retireAllCursors()
      if (!this.closedByUser) this.scheduleReconnect()
    }
    this.ws.onerror = () => {
      this.ws?.close()
    }
  }

  disconnect() {
    this.closedByUser = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.stopPinging()
    this.ws?.close()
  }

  // ---- liveness ----

  private startPinging() {
    this.stopPinging()
    if (typeof setInterval === 'undefined') return
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      if (linkExpired(this.lastInboundAt, Date.now())) {
        // Half-open: the browser still calls this socket OPEN and every send
        // reports success, but nothing has come back. Close it so `onclose`
        // runs the normal reconnect (and retires the orphaned cursors).
        this.ws.close()
        return
      }
      this.sendRaw({ type: 'ping', timestamp: Date.now() / 1000 })
    }, PING_INTERVAL_MS)
  }

  private stopPinging() {
    if (this.pingTimer === null) return
    clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  /**
   * Waking from sleep and regaining network are the two moments a reconnect is
   * most likely to succeed and least likely to be already scheduled — waiting
   * out a 10s backoff there is the difference between the set answering and the
   * director thinking it is broken.
   */
  private bindWakeListeners() {
    if (this.wakeListenersBound) return
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    this.wakeListenersBound = true
    const wake = () => {
      if (this.closedByUser || !this.url) return
      if (this.ws?.readyState === WebSocket.OPEN) return
      this.reconnectNow()
    }
    window.addEventListener('online', wake)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') wake()
    })
  }

  /** Drop any pending backoff and retry immediately. */
  private reconnectNow() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.attempts = 0
    this.connect()
  }

  private scheduleReconnect() {
    if (!this.url) return
    if (this.reconnectTimer) return
    const base = Math.min(10_000, 1_000 * 2 ** this.attempts)
    const jitter = base * (0.8 + Math.random() * 0.4)
    this.attempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, jitter)
  }

  private setStatus(status: SocketStatus) {
    this.status = status
    for (const cb of this.statusListeners) cb(status)
  }

  private sendRaw(obj: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(obj))
    return true
  }

  /**
   * `sent` — it is on the wire. `held` — the link is down but the command is
   * queued and will replay on reconnect. `unconfigured` — there is no server
   * to reach in this build, so waiting for one would be a lie.
   */
  async sendUserCommand(
    text: string,
    opts?: {
      forceVision?: boolean
      commandId?: string
      targetHint?: { id: string; name: string }
    }
  ): Promise<{ commandId: string; delivery: 'sent' | 'held' | 'unconfigured' }> {
    const commandId = opts?.commandId ?? newCommandId()
    const attachVision = opts?.forceVision === true || shouldAttachVision(text)
    const frame = attachVision ? await captureViewfinderFrame() : null
    const payload: Record<string, unknown> = {
      type: 'user_command',
      timestamp: Date.now() / 1000,
      text,
      commandId,
      scene: { type: 'scene_state', timestamp: Date.now() / 1000, ...buildFullSnapshot() },
      ...(frame ? { frame } : {}),
      ...(opts?.targetHint ? { targetHint: opts.targetHint } : {}),
    }
    if (this.sendRaw(payload)) return { commandId, delivery: 'sent' }
    if (!this.url) return { commandId, delivery: 'unconfigured' }
    // Hold it. The same commandId rides the replay, so a later cancel or
    // supersede still matches the choreography this command already started.
    this.outbox = admitToQueue(this.outbox, { queuedAt: Date.now(), payload }, Date.now())
    return { commandId, delivery: 'held' }
  }

  /**
   * Replay whatever the link owes, oldest first.
   *
   * The scene snapshot inside each held payload is deliberately *not* refreshed
   * — the server grounds the parse in the set as it was when the director
   * spoke, which is the set they were describing.
   */
  private flushOutbox() {
    if (this.outbox.length === 0) return
    const due = pruneQueue(this.outbox, Date.now())
    this.outbox = []
    for (const entry of due) {
      if (!this.sendRaw(entry.payload)) {
        // Lost it again mid-flush; keep the rest for the next open.
        this.outbox.push(entry)
      }
    }
  }

  sendSceneState(snapshot: Omit<SceneSnapshot, 'type' | 'timestamp'>): boolean {
    return this.sendRaw({ type: 'scene_state', timestamp: Date.now() / 1000, ...snapshot })
  }

  sendToolResult(msg: AgentToolResultMessage): boolean {
    return this.sendRaw(msg)
  }

  sendAgentAbort(commandId: string): boolean {
    const msg: AgentAbortMessage = {
      type: 'agent_abort',
      timestamp: Date.now() / 1000,
      commandId,
    }
    return this.sendRaw(msg)
  }

  onToolUse(cb: Listener<AgentToolUseMessage>): () => void {
    this.toolUseListeners.add(cb)
    return () => this.toolUseListeners.delete(cb)
  }

  onPacket(cb: Listener<CommandPacket>): () => void {
    this.packetListeners.add(cb)
    return () => this.packetListeners.delete(cb)
  }

  onLog(cb: Listener<AgentLogMessage>): () => void {
    this.logListeners.add(cb)
    return () => this.logListeners.delete(cb)
  }

  onAgentStatus(cb: Listener<AgentStatusMessage>): () => void {
    this.agentStatusListeners.add(cb)
    return () => this.agentStatusListeners.delete(cb)
  }

  onIntentPreview(cb: Listener<IntentPreviewMessage>): () => void {
    this.intentPreviewListeners.add(cb)
    return () => this.intentPreviewListeners.delete(cb)
  }

  onCancel(cb: Listener<CommandCancelMessage>): () => void {
    this.cancelListeners.add(cb)
    return () => this.cancelListeners.delete(cb)
  }

  onQuestion(cb: Listener<AgentQuestionMessage>): () => void {
    this.questionListeners.add(cb)
    return () => this.questionListeners.delete(cb)
  }

  onSuggestion(cb: Listener<AgentSuggestionMessage>): () => void {
    this.suggestionListeners.add(cb)
    return () => this.suggestionListeners.delete(cb)
  }

  onPlanUpdate(cb: Listener<PlanUpdateMessage>): () => void {
    this.planUpdateListeners.add(cb)
    return () => this.planUpdateListeners.delete(cb)
  }

  onError(cb: Listener<ErrorMessage>): () => void {
    this.errorListeners.add(cb)
    return () => this.errorListeners.delete(cb)
  }

  onStatus(cb: Listener<SocketStatus>): () => void {
    this.statusListeners.add(cb)
    return () => this.statusListeners.delete(cb)
  }

  onOpen(cb: () => void): () => void {
    this.openListeners.add(cb)
    if (this.status === 'open') cb()
    return () => this.openListeners.delete(cb)
  }
}

let singleton: DirectorSocket | null = null

export function getDirectorSocket(): DirectorSocket {
  if (!singleton) singleton = new DirectorSocket()
  return singleton
}
