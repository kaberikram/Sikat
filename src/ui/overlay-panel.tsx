import React from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import { useEditorStore } from '../store'
import type { OverlayKey } from './overlay-commands'

interface OverlayPanelProps {
  overlayKey: OverlayKey
  title: string
  className: string
  open: boolean
  children: React.ReactNode
}

/**
 * These are glass surfaces, so they arrive like a material rather than a fade:
 * blur and scale resolve together, anchored at the panel's screen corner (the
 * transform-origin lives with each `.overlay-*` rule) so it grows from where it
 * lives instead of out of its own middle. Exit mirrors the path exactly.
 */
export function OverlayPanel({ overlayKey, title, className, open, children }: OverlayPanelProps) {
  const setOverlay = useEditorStore((s) => s.setOverlay)
  const reduceMotion = useReducedMotion()
  const enter = reduceMotion
    ? { opacity: 0 }
    : { opacity: 0, scale: 0.94, filter: 'blur(8px)' }
  const shown = reduceMotion
    ? { opacity: 1 }
    : { opacity: 1, scale: 1, filter: 'blur(0px)' }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={`overlay-panel ${className}`}
          initial={enter}
          animate={shown}
          exit={enter}
          transition={
            reduceMotion
              ? { duration: 0.2, ease: [0.23, 1, 0.32, 1] }
              : { type: 'spring', stiffness: 460, damping: 43 }
          }
        >
          <div className="overlay-header">
            <span className="panel-title mb-0">{title}</span>
            <button
              type="button"
              className="overlay-close"
              onClick={() => setOverlay(overlayKey, false)}
            >
              ×
            </button>
          </div>
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
