import React from 'react'
import { motion, AnimatePresence } from 'motion/react'
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

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={`overlay-panel ${className}`}
          initial={{ opacity: 0, scale: 0.94, filter: 'blur(8px)' }}
          animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
          exit={{ opacity: 0, scale: 0.94, filter: 'blur(8px)' }}
          transition={{ type: 'spring', stiffness: 460, damping: 43 }}
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
