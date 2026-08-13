import React from 'react'
import { Pause, Play } from 'lucide-react'
import { useEditorStore, VIRTUAL_CAMERA_ID } from '../store'
import { OverlayPanel } from './overlay-panel'
import { cn } from './cn'

function displayName(name: string): string {
  return name.toLowerCase()
}

function TimelineTrackRow({
  name,
  keyframes,
  duration,
  onSeek,
  selected,
}: {
  name: string
  keyframes: { time: number }[]
  duration: number
  onSeek: (t: number) => void
  selected: boolean
}) {
  return (
    <div className="timeline-track">
      <span className="timeline-track-label">{displayName(name)}</span>
      <div
        className="timeline-lane"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const x = e.clientX - rect.left
          onSeek((x / rect.width) * duration)
        }}
      >
        {keyframes.map((kf, idx) => (
          <div
            key={idx}
            className={cn('keyframe', selected && 'active')}
            style={{ left: `${(kf.time / Math.max(duration, 0.001)) * 100}%` }}
          />
        ))}
      </div>
    </div>
  )
}

function TimelineRuler({
  duration,
  currentTime,
  onSeek,
}: {
  duration: number
  currentTime: number
  onSeek: (t: number) => void
}) {
  const span = Math.max(duration, 0.001)
  const lastTick = Math.max(1, Math.ceil(span))
  const ticks: number[] = []
  for (let t = 0; t <= lastTick; t++) ticks.push(t)

  return (
    <div
      className="timeline-ruler"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        const x = e.clientX - rect.left
        onSeek((x / rect.width) * span)
      }}
    >
      {ticks.map((t) => {
        const left = `${(t / lastTick) * 100}%`
        return (
          <React.Fragment key={t}>
            {t > 0 && t < lastTick ? (
              <div className="timeline-tick-line" style={{ left }} />
            ) : null}
            <span className="timeline-tick" style={{ left: `calc(${left} + 9px)` }}>
              {t}
            </span>
          </React.Fragment>
        )
      })}
      <div
        className="timeline-playhead"
        style={{ left: `${(currentTime / span) * 100}%` }}
      />
    </div>
  )
}

/**
 * The body owns the per-frame `currentTime` subscription so it only ticks while
 * the panel is actually mounted — same reason DirectorPod splits its transport
 * readouts out.
 */
function TimelineBody() {
  const currentTime = useEditorStore((s) => s.currentTime)
  const duration = useEditorStore((s) => s.duration)
  const setTime = useEditorStore((s) => s.setTime)
  const isPlaying = useEditorStore((s) => s.isPlaying)
  const togglePlay = useEditorStore((s) => s.togglePlay)
  const objects = useEditorStore((s) => s.objects)
  const virtualCamera = useEditorStore((s) => s.virtualCamera)
  const selectedId = useEditorStore((s) => s.selectedId)

  return (
    <>
      <div className="timeline-transport-row">
        <button type="button" className="timeline-transport" onClick={togglePlay}>
          {isPlaying ? <Pause size={11} fill="currentColor" /> : <Play size={11} fill="currentColor" />}
          <span>{currentTime.toFixed(2)}s</span>
        </button>
        <TimelineRuler duration={duration} currentTime={currentTime} onSeek={setTime} />
      </div>
      <div className="timeline-tracks">
        <TimelineTrackRow
          name="virtual_camera"
          keyframes={virtualCamera.keyframes}
          duration={duration}
          onSeek={setTime}
          selected={selectedId === VIRTUAL_CAMERA_ID}
        />
        {objects.map((obj) => (
          <React.Fragment key={obj.id}>
            <TimelineTrackRow
              name={obj.name}
              keyframes={obj.keyframes}
              duration={duration}
              onSeek={setTime}
              selected={selectedId === obj.id}
            />
          </React.Fragment>
        ))}
      </div>
    </>
  )
}

export function TimelineOverlay() {
  const open = useEditorStore((s) => s.overlayTimeline)

  return (
    <OverlayPanel overlayKey="timeline" title="timeline" className="overlay-timeline" open={open}>
      <TimelineBody />
    </OverlayPanel>
  )
}
