/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Viewfinder-only FX; main viewport is clean. `Scene.tsx` is the only renderer-aware module.
 */

import React, { useRef } from 'react'
import { useMountEffect } from './hooks/useMountEffect'
import { bootstrapScene } from './scene/bootstrap'

interface SceneProps {
  pipMountEl: HTMLDivElement | null
}

function SceneInstance({ pipMountEl }: { pipMountEl: HTMLDivElement }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useMountEffect(() => {
    const container = containerRef.current
    if (!container) return
    return bootstrapScene(container, pipMountEl)
  })

  return <div ref={containerRef} id="canvas-container" className="relative z-0 h-full w-full min-h-0" />
}

export const Scene: React.FC<SceneProps> = ({ pipMountEl }) => {
  if (!pipMountEl) return null
  return (
    <div key={pipMountEl.id || 'pip'} className="absolute inset-0">
      <SceneInstance pipMountEl={pipMountEl} />
    </div>
  )
}
