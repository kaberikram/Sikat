import { useEffect } from 'react'

/** Mount/unmount external sync only — see AGENTS.md decision tree. */
export function useMountEffect(callback: () => void | (() => void)) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(callback, [])
}
