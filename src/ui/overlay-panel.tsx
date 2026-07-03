import React from 'react'
import { useEditorStore } from '../store'
import type { OverlayKey } from './overlay-commands'

interface OverlayPanelProps {
  overlayKey: OverlayKey
  title: string
  className: string
  children: React.ReactNode
}

export function OverlayPanel({ overlayKey, title, className, children }: OverlayPanelProps) {
  const setOverlay = useEditorStore((s) => s.setOverlay)

  return (
    <div className={`overlay-panel ${className}`}>
      <div className="overlay-header">
        <span className="panel-title mb-0">{title}</span>
        <button type="button" className="overlay-close" onClick={() => setOverlay(overlayKey, false)}>
          ×
        </button>
      </div>
      {children}
    </div>
  )
}
