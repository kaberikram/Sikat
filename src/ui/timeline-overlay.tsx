import React from 'react'
import { useEditorStore } from '../store'
import { Button } from './button'
import { OverlayPanel } from './overlay-panel'

function TimelineTrackRow({
  name,
  keyframes,
  duration,
  currentTime,
  onSeek,
  showScrub,
}: {
  name: string
  keyframes: { time: number }[]
  duration: number
  currentTime: number
  onSeek: (t: number) => void
  showScrub: boolean
}) {
  return (
    <div className="track relative group min-h-8">
      <span className="text-[11px] font-semibold w-24 px-3 rounded-full bg-white/70 text-ink mr-4 my-1 truncate flex items-center self-center h-6">
        {name}
      </span>
      <div
        className="flex-1 h-full min-h-8 relative cursor-pointer"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const x = e.clientX - rect.left
          onSeek((x / rect.width) * duration)
        }}
      >
        {keyframes.map((kf, idx) => (
          <div
            key={idx}
            className="keyframe absolute top-1/2 -translate-y-1/2"
            style={{ left: `${(kf.time / duration) * 100}%` }}
          />
        ))}
        {showScrub ? (
          <input
            type="range"
            min={0}
            max={duration}
            step={0.01}
            value={currentTime}
            onChange={(e) => onSeek(parseFloat(e.target.value))}
            className="absolute inset-0 opacity-0 cursor-pointer w-full z-10"
          />
        ) : null}
      </div>
    </div>
  )
}

export function TimelineOverlay() {
  const open = useEditorStore((s) => s.overlayTimeline)
  const currentTime = useEditorStore((s) => s.currentTime)
  const duration = useEditorStore((s) => s.duration)
  const setTime = useEditorStore((s) => s.setTime)
  const isPlaying = useEditorStore((s) => s.isPlaying)
  const togglePlay = useEditorStore((s) => s.togglePlay)
  const objects = useEditorStore((s) => s.objects)
  const virtualCamera = useEditorStore((s) => s.virtualCamera)

  if (!open) return null

  return (
    <OverlayPanel overlayKey="timeline" title="TIMELINE" className="overlay-timeline">
      <div className="timeline-controls">
        <div className="flex gap-4 items-center">
          <Button variant="dark" size="sm" onClick={togglePlay}>
            {isPlaying ? 'PAUSE' : 'PLAY'}
          </Button>
          <span className="text-xs font-mono font-bold">{currentTime.toFixed(2)}s</span>
        </div>
      </div>
      <div className="timeline-tracks flex-grow overflow-y-auto max-h-40">
        <TimelineTrackRow
          name="VIRTUAL_CAMERA"
          keyframes={virtualCamera.keyframes}
          duration={duration}
          currentTime={currentTime}
          onSeek={setTime}
          showScrub
        />
        {objects.map((obj) => (
          <div key={obj.id}>
            <TimelineTrackRow
              name={obj.name}
              keyframes={obj.keyframes}
              duration={duration}
              currentTime={currentTime}
              onSeek={setTime}
              showScrub
            />
          </div>
        ))}
      </div>
    </OverlayPanel>
  )
}
