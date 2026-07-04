import { useEditorStore } from '../store'
import { OVERLAY_COMMANDS } from '../ui/overlay-commands'

export interface LocalCommandResult {
  handled: boolean
  message?: string
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

const START_CUES = [
  /^(?:and\s+)?action$/,
  /^camera'?s?\s+(?:is\s+)?rolling$/,
  /^start\s+recording$/,
  /^we'?re\s+rolling$/,
  /^roll\s+(?:camera|sound|it)$/,
]

const STOP_CUES = [
  /^cut$/,
  /^that'?s\s+a\s+cut$/,
  /^stop\s+recording$/,
]

function tryTransport(text: string): LocalCommandResult | null {
  const t = text.trim().toLowerCase()
  const store = useEditorStore.getState()

  if (/^(play|go|resume|continue)$/.test(t)) {
    if (!store.isPlaying) store.togglePlay()
    return { handled: true, message: 'play' }
  }
  if (/^(pause|hold|freeze)$/.test(t)) {
    if (store.isPlaying) store.togglePlay()
    return { handled: true, message: 'pause' }
  }
  if (/^stop$/.test(t)) {
    if (store.isPlaying) store.togglePlay()
    store.setPlaybackLoop(false)
    return { handled: true, message: 'stop' }
  }
  if (/^(loop|loop it|keep looping|on repeat)$/.test(t)) {
    store.setPlayOnceEnd(null)
    store.setPlaybackLoop(true)
    if (!store.isPlaying) store.togglePlay()
    return { handled: true, message: 'loop on' }
  }
  if (/^(play once|no loop|don'?t loop|once only)$/.test(t)) {
    store.setPlaybackLoop(false)
    store.setClipLoopEnd(null)
    return { handled: true, message: 'loop off' }
  }
  if (/^(rewind|back to start|back to one|top of scene|from the top|restart)$/.test(t)) {
    store.setTime(0)
    store.setPlayOnceEnd(null)
    if (!store.isPlaying) store.togglePlay()
    return { handled: true, message: 'rewind + play' }
  }
  const seek = t.match(/^(?:go to|seek to|jump to|at)\s+(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)?$/)
  if (seek) {
    const time = parseFloat(seek[1])
    store.setTime(Math.max(0, Math.min(store.duration, time)))
    return { handled: true, message: `at ${time}s` }
  }
  return null
}

function tryTakeCue(text: string): LocalCommandResult | null {
  const t = text.trim().toLowerCase()
  if (wordCount(t) > 6) return null
  const store = useEditorStore.getState()
  for (const re of START_CUES) {
    if (re.test(t)) {
      store.startTake()
      return { handled: true, message: `rolling — take ${useEditorStore.getState().takeNumber}` }
    }
  }
  for (const re of STOP_CUES) {
    if (re.test(t)) {
      if (store.isRolling) store.endTake()
      else if (store.isPlaying) store.togglePlay()
      return { handled: true, message: 'cut' }
    }
  }
  return null
}

export function tryLocalCommand(text: string): LocalCommandResult {
  const t = text.trim().toLowerCase()
  if (!t) return { handled: false }

  const store = useEditorStore.getState()

  const transport = tryTransport(t)
  if (transport) return transport

  const takeCue = tryTakeCue(t)
  if (takeCue) return takeCue

  if (/^(camera\s+mode|free\s+camera)\s+on$/.test(t) || t === 'camera op on') {
    store.setCameraOpMode(true)
    return { handled: true, message: 'camera op on' }
  }
  if (/^(camera\s+mode|free\s+camera)\s+off$/.test(t) || t === 'camera op off' || t === 'exit camera mode') {
    store.setCameraOpMode(false)
    return { handled: true, message: 'camera op off' }
  }

  for (const cmd of OVERLAY_COMMANDS) {
    if (cmd.openPhrases.some((re) => re.test(t))) {
      store.setOverlay(cmd.key, true)
      return { handled: true, message: `${cmd.key} opened` }
    }
    if (cmd.closePhrases.some((re) => re.test(t))) {
      store.setOverlay(cmd.key, false)
      return { handled: true, message: `${cmd.key} closed` }
    }
  }

  if (/^(hide|close)\s+all$/.test(t)) {
    store.closeAllOverlays()
    return { handled: true, message: 'overlays closed' }
  }
  if (/^(deselect|clear selection)$/.test(t)) {
    store.setSelected(null)
    return { handled: true, message: 'selection cleared' }
  }

  return { handled: false }
}
