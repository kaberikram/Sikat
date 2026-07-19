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
import { newCommandId } from './ids'
import { buildFullSnapshot } from './scene-state-sync'
import { shouldAttachVision } from './vision-triggers'
import { captureViewfinderFrame } from './viewfinder-capture'

export type SocketStatus = 'connecting' | 'open' | 'closed'

type Listener<T> = (value: T) => void

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

  connect() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return
    if (!this.url) {
      this.setStatus('closed')
      return
    }
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
      this.setStatus('open')
      for (const cb of this.openListeners) cb()
    }
    this.ws.onmessage = (event) => {
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
      this.setStatus('closed')
      if (!this.closedByUser) this.scheduleReconnect()
    }
    this.ws.onerror = () => {
      this.ws?.close()
    }
  }

  disconnect() {
    this.closedByUser = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
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

  /** Returns the commandId used, or null when the socket is not open. */
  async sendUserCommand(
    text: string,
    opts?: {
      forceVision?: boolean
      commandId?: string
      targetHint?: { id: string; name: string }
    }
  ): Promise<string | null> {
    const commandId = opts?.commandId ?? newCommandId()
    const attachVision = opts?.forceVision === true || shouldAttachVision(text)
    const frame = attachVision ? await captureViewfinderFrame() : null
    const sent = this.sendRaw({
      type: 'user_command',
      timestamp: Date.now() / 1000,
      text,
      commandId,
      scene: { type: 'scene_state', timestamp: Date.now() / 1000, ...buildFullSnapshot() },
      ...(frame ? { frame } : {}),
      ...(opts?.targetHint ? { targetHint: opts.targetHint } : {}),
    })
    return sent ? commandId : null
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
