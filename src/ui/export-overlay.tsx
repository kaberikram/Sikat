import React, { useState } from 'react'
import { useEditorStore } from '../store'
import { exportMp4 } from '../exporter'
import { OverlayPanel } from './overlay-panel'

function ExportMp4Modal({
  open,
  onClose,
  defaultDuration,
}: {
  open: boolean
  onClose: () => void
  defaultDuration: number
}) {
  const [w, setW] = useState(1920)
  const [h, setH] = useState(1080)
  const [fps, setFps] = useState(60)
  const [dur, setDur] = useState(defaultDuration)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white border-4 border-black brutalist-shadow max-w-md w-full p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-black uppercase tracking-tight mb-3">Export MP4</h2>
        <div className="grid grid-cols-2 gap-2 text-[10px]">
          <label className="col-span-1">
            <span className="block font-bold mb-0.5">Width</span>
            <input
              type="number"
              value={w}
              onChange={(e) => setW(parseInt(e.target.value, 10) || 1)}
              className="w-full border-2 border-black p-1"
            />
          </label>
          <label>
            <span className="block font-bold mb-0.5">Height</span>
            <input
              type="number"
              value={h}
              onChange={(e) => setH(parseInt(e.target.value, 10) || 1)}
              className="w-full border-2 border-black p-1"
            />
          </label>
          <label>
            <span className="block font-bold mb-0.5">FPS</span>
            <input
              type="number"
              value={fps}
              onChange={(e) => setFps(parseInt(e.target.value, 10) || 1)}
              className="w-full border-2 border-black p-1"
            />
          </label>
          <label>
            <span className="block font-bold mb-0.5">Duration (s)</span>
            <input
              type="number"
              value={dur}
              onChange={(e) => setDur(parseFloat(e.target.value) || 0.1)}
              className="w-full border-2 border-black p-1"
            />
          </label>
        </div>
        {error ? <p className="text-red-600 text-[10px] mt-2">{error}</p> : null}
        <div className="mt-3 h-3 border-2 border-black bg-black/10">
          <div
            className="h-full bg-jsr-orange transition-[width] duration-150"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
        <div className="mt-3 flex gap-2 justify-end">
          <button type="button" className="nav-btn" onClick={onClose} disabled={running}>
            CANCEL
          </button>
          <button
            type="button"
            className="nav-btn"
            style={{ background: 'var(--jsr-pink)', color: 'white' }}
            disabled={running}
            onClick={async () => {
              setError(null)
              setRunning(true)
              setProgress(0)
              try {
                const blob = await exportMp4({
                  width: w,
                  height: h,
                  fps,
                  duration: dur,
                  onProgress: setProgress,
                })
                const a = document.createElement('a')
                a.href = URL.createObjectURL(blob)
                a.download = `radio_edit_${Date.now()}.mp4`
                a.click()
                URL.revokeObjectURL(a.href)
                onClose()
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Export failed')
              } finally {
                setRunning(false)
              }
            }}
          >
            {running ? 'ENCODING...' : 'START'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ExportOverlay() {
  const open = useEditorStore((s) => s.overlayExport)
  const setOverlay = useEditorStore((s) => s.setOverlay)
  const objects = useEditorStore((s) => s.objects)
  const virtualCamera = useEditorStore((s) => s.virtualCamera)
  const duration = useEditorStore((s) => s.duration)
  const [mp4Open, setMp4Open] = useState(false)

  const handleExportJson = () => {
    const data = {
      virtualCamera: {
        position: virtualCamera.position,
        rotation: virtualCamera.rotation,
        fov: virtualCamera.fov,
        keyframes: virtualCamera.keyframes,
        postProcessing: virtualCamera.postProcessing,
      },
      objects: objects.map((o) => ({
        name: o.name,
        position: o.position,
        rotation: o.rotation,
        scale: o.scale,
        keyframes: o.keyframes,
      })),
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'radio_edit_export.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!open && !mp4Open) return null

  return (
    <>
      {open && (
        <OverlayPanel overlayKey="export" title="EXPORT" className="overlay-export">
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={handleExportJson}
              className="nav-btn brutalist-shadow w-full"
              style={{ background: 'var(--jsr-pink)', color: 'white' }}
            >
              EXPORT_JSON
            </button>
            <button
              type="button"
              onClick={() => setMp4Open(true)}
              className="nav-btn brutalist-shadow w-full"
              style={{ background: 'var(--jsr-pink)', color: 'white' }}
            >
              EXPORT_MP4
            </button>
          </div>
        </OverlayPanel>
      )}
      <ExportMp4Modal open={mp4Open} onClose={() => setMp4Open(false)} defaultDuration={duration} />
    </>
  )
}
