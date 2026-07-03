import React, { useState } from 'react'
import { useEditorStore, VIRTUAL_CAMERA_ID } from './store'
import { Scene } from './Scene'
import { DirectorPod } from './director/DirectorPod'
import { TimelineOverlay } from './ui/timeline-overlay'
import { ObjectsOverlay } from './ui/objects-overlay'
import { ExportOverlay } from './ui/export-overlay'

export const Editor: React.FC = () => {
  const [pipMountEl, setPipMountEl] = useState<HTMLDivElement | null>(null)
  const setSelected = useEditorStore((s) => s.setSelected)

  return (
    <div className="director-shell bg-[var(--bg-color)]">
      <main className="viewport relative overflow-hidden viewport-bg">
        <div className="absolute inset-0">
          <Scene pipMountEl={pipMountEl} />
        </div>

        <div
          role="button"
          tabIndex={0}
          onClick={() => setSelected(VIRTUAL_CAMERA_ID)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') setSelected(VIRTUAL_CAMERA_ID)
          }}
          className="pip-frame z-20 border-4 border-black bg-black brutalist-shadow relative cursor-pointer"
        >
          <div className="absolute top-0 left-0 z-10 p-1 bg-white border-b-2 border-r-2 border-black text-[8px] font-mono">
            VIRTUAL_CAM
          </div>
          <div ref={setPipMountEl} className="absolute inset-0" />
        </div>

        <TimelineOverlay />
        <ObjectsOverlay />
        <ExportOverlay />
        <DirectorPod />
      </main>
    </div>
  )
}
