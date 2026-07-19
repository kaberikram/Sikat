/**
 * Minimal toast layer: transient error notices (GLB import failures, etc.)
 * plus a persistent banner when the render loop has fatally halted.
 */
import React from 'react'
import { create } from 'zustand'
import { motion, AnimatePresence } from 'motion/react'
import { useEditorStore } from '../store'

interface Toast {
  id: number
  text: string
}

interface ToastState {
  toasts: Toast[]
  push: (text: string) => void
  dismiss: (id: number) => void
}

let toastCounter = 0
const TOAST_TTL_MS = 6000

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (text) => {
    const id = ++toastCounter
    set((state) => ({ toasts: [...state.toasts.slice(-2), { id, text }] }))
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
    }, TOAST_TTL_MS)
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}))

/** Fire-and-forget error notice from non-React code. */
export function pushToast(text: string): void {
  useToastStore.getState().push(text)
}

export function Toasts() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)
  const fatalRenderError = useEditorStore((s) => s.fatalRenderError)

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 pointer-events-none">
      {fatalRenderError && (
        <div className="pointer-events-auto flex items-center gap-3 px-4 py-2 rounded-full bg-rec text-white text-[11px] font-mono font-bold shadow-[var(--shadow-lift)]">
          RENDER LOOP HALTED — the 3D view stopped after repeated errors
          <button
            type="button"
            className="px-2.5 py-0.5 rounded-full bg-white text-rec hover:bg-candy-sun transition-colors"
            onClick={() => location.reload()}
          >
            RELOAD
          </button>
        </div>
      )}
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.button
            key={toast.id}
            type="button"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            onClick={() => dismiss(toast.id)}
            className="pointer-events-auto px-4 py-1.5 rounded-full bg-ink text-white text-[11px] font-mono shadow-[var(--shadow-lift)] cursor-pointer"
          >
            {toast.text}
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  )
}
