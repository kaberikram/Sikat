import React, { useState } from 'react'
import { useEditorStore, VIRTUAL_CAMERA_ID } from './store'
import { Scene } from './Scene'
import { DirectorPod } from './director/DirectorPod'
import { TimelineOverlay } from './ui/timeline-overlay'
import { ObjectsOverlay } from './ui/objects-overlay'
import { ExportOverlay } from './ui/export-overlay'
import { Toasts } from './ui/toast'
import { Button } from './ui/button'
import { useMountEffect } from './hooks/useMountEffect'
import { endXrSession, probeImmersiveArSupport, requestXrSession } from './scene/xr/xr-bridge'
import { requestMicPermission } from './director/voice-session'

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
      // Ask for mic access here, before going immersive: the permission
      // dialog can't render once inside the XR session on headset browsers
      // (e.g. Meta Quest Browser), so push-to-talk would otherwise silently
      // fail with no trigger to grant it. Request unconditionally —
      // getUserMedia is independent of SpeechRecognition feature detection.
      await requestMicPermission()
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
    <div className="director-shell bg-cream">
      <main className="viewport relative overflow-hidden viewport-bg">
        <div className="absolute inset-0">
          <Scene pipMountEl={pipMountEl} />
        </div>

        {xrSupported && !xrActive && (
          <Button
            variant="dark"
            onClick={() => void handleEnterXr()}
            className="absolute top-3 left-3 z-30"
          >
            ENTER XR
          </Button>
        )}

        {xrActive && (
          <Button
            variant="primary"
            onClick={() => void handleExitXr()}
            className="absolute top-3 left-3 z-30"
          >
            EXIT XR
          </Button>
        )}

        <div
          role="button"
          tabIndex={0}
          onClick={() => setSelected(VIRTUAL_CAMERA_ID)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') setSelected(VIRTUAL_CAMERA_ID)
          }}
          className={`pip-frame z-20 rounded-[var(--radius-card)] overflow-hidden bg-ink shadow-[var(--shadow-soft)] ring-1 ring-line relative cursor-pointer ${xrActive ? 'sr-only fixed left-[-9999px] w-[320px] h-[180px]' : ''}`}
        >
          <div className="absolute top-2 left-2 z-10 px-2 py-0.5 rounded-full bg-white/80 backdrop-blur text-[10px] font-mono text-ink">
            VIRTUAL_CAM
          </div>
          <div ref={setPipMountEl} className="absolute inset-0" />
        </div>

        <TimelineOverlay />
        <ObjectsOverlay />
        <ExportOverlay />
        <DirectorPod />
        <Toasts />
      </main>
    </div>
  )
}
