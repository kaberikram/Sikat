import { useEditorStore } from '../store'
import { OVERLAY_COMMANDS } from '../ui/overlay-commands'

export interface LocalCommandResult {
  handled: boolean
  message?: string
}

export function tryLocalCommand(text: string): LocalCommandResult {
  const t = text.trim().toLowerCase()
  if (!t) return { handled: false }

  const store = useEditorStore.getState()

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
