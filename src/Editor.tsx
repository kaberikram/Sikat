import React, { useState } from 'react'
import { useEditorStore, VIRTUAL_CAMERA_ID } from './store'
import { Scene } from './Scene'
import { DirectorPod } from './director/DirectorPod'
import { TimelineOverlay } from './ui/timeline-overlay'
import { ObjectsOverlay } from './ui/objects-overlay'
import { ExportOverlay } from './ui/export-overlay'
import { useMountEffect } from './hooks/useMountEffect'
import { endXrSession, probeImmersiveArSupport, requestXrSession } from './scene/xr/xr-bridge'

export const Editor: React.FC = () => {
  const [pipMountEl, setPipMountEl] = useState<HTMLDivElement | null>(null)
  const setSelected = useEditorStore((s) => s.setSelected)
  const xrActive = useEditorStore((s) => s.xrActive)
  const xrSupported = useEditorStore((s) => s.xrSupported)
  const setXrSupported = useEditorStore((s) => s.setXrSupported)

  useMountEffect(() => {
    void probeImmersiveArSupport().then(setXrSupported)
  })

  async function handleEnterXr(): Promise<void> {
    try {
      await requestXrSession()
    } catch (err) {
      console.error('XR session failed', err)
    }
  }

  async function handleExitXr(): Promise<void> {
    try {
      await endXrSession()
    } catch (err) {
      console.error('XR exit failed', err)
    }
  }

  return (
    <div className="director-shell bg-[var(--bg-color)]">
      <main className="viewport relative overflow-hidden viewport-bg">
        <div className="absolute inset-0">
          <Scene pipMountEl={pipMountEl} />
        </div>

        {xrSupported && !xrActive && (
          <button
            type="button"
            onClick={() => void handleEnterXr()}
            className="absolute top-3 left-3 z-30 border-4 border-black bg-white px-3 py-1.5 font-mono text-xs font-bold brutalist-shadow hover:bg-[var(--accent-color)]"
          >
            ENTER XR
          </button>
        )}

        {xrActive && (
          <button
            type="button"
            onClick={() => void handleExitXr()}
            className="absolute top-3 left-3 z-30 border-4 border-black bg-[var(--accent-color)] px-3 py-1.5 font-mono text-xs font-bold brutalist-shadow hover:bg-white"
          >
            EXIT XR
          </button>
        )}

        <div
          role="button"
          tabIndex={0}
          onClick={() => setSelected(VIRTUAL_CAMERA_ID)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') setSelected(VIRTUAL_CAMERA_ID)
          }}
          className={`pip-frame z-20 border-4 border-black bg-black brutalist-shadow relative cursor-pointer ${xrActive ? 'sr-only fixed left-[-9999px] w-[320px] h-[180px]' : ''}`}
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
