/**
 * Generic Zustand store dispatch for the SceneAgent (CALL_STORE_ACTION).
 *
 * Anything the UI can do, the agent can do: the action name is looked up on
 * useEditorStore.getState() and invoked with positional args. Args are NOT
 * validated — a bad call breaks scene state, nothing else. The two guards
 * below only block prototype-chain lookups and non-function keys.
 *
 * Action signatures are documented for the LLM in server/app/store_actions.py
 * — keep that file in sync with src/store.ts.
 */
import { useEditorStore } from '../store'

export function callStoreAction(action: string, args: unknown[]): string {
  const st = useEditorStore.getState()
  if (!Object.prototype.hasOwnProperty.call(st, action)) {
    throw new Error(`unknown store action: ${action}`)
  }
  const fn = (st as unknown as Record<string, unknown>)[action]
  if (typeof fn !== 'function') {
    throw new Error(`${action} is state, not an action`)
  }
  ;(fn as (...a: unknown[]) => void)(...args)
  return `${action}(${JSON.stringify(args).slice(1, -1)})`
}
