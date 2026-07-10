import type { CursorPhase } from '../director/presence'

export interface CursorStatusInput {
  active: boolean
  phase: CursorPhase | undefined
  hasConfirmedNote: boolean
}

export interface CursorStatusVisibility {
  showCheck: boolean
  showNote: boolean
  showSpinner: boolean
}

export function getCursorStatusVisibility({
  active,
  phase,
  hasConfirmedNote,
}: CursorStatusInput): CursorStatusVisibility {
  const showCheck = phase === 'settling' || phase === 'done'
  // Intent = still thinking — keep the spinner even when a preview note exists.
  // Note appears once the cursor is flying / working.
  const isThinking = phase === 'intent'
  const showNote = hasConfirmedNote && !isThinking && !showCheck
  const showSpinner = active && !showCheck && !showNote

  return { showCheck, showNote, showSpinner }
}
