import * as THREE from 'three'
import { Muxer, ArrayBufferTarget, type MuxerOptions } from 'mp4-muxer'
import { createViewfinderComposer, renderViewfinderFrame } from './pip-composer'
import { applyObjectTransformAtTime, applyVirtualCameraAtTime } from './timeline-apply'
import {
  applyViewfinderMeshEffects,
  stripViewfinderObjectEffects,
} from './viewfinder-mesh-fx'
import { getSceneForExport } from './scene-export-registry'
import { useEditorStore } from './store'

export interface ExportMp4Options {
  width?: number
  height?: number
  fps?: number
  /** Seconds; defaults to store `duration` */
  duration?: number
  onProgress?: (p: number) => void
}

/** Muxed MP4 track codec; must match the encoder’s output (see mp4-muxer `VideoOptions.codec`). */
type MuxerVideoCodec = NonNullable<NonNullable<MuxerOptions<ArrayBufferTarget>['video']>['codec']>

interface PickedWebCodecsVideo {
  config: VideoEncoderConfig
  muxerCodec: MuxerVideoCodec
}

/**
 * Picks a WebCodecs encoder + muxer codec.
 * - H.264 (avc) is the most compatible everywhere.
 * - On many Macs, H.264 *encoding* is unavailable in Chrome, but **HEVC** (hvc1) often is
 *   (VideoToolbox). That plays in iOS Photos / Apple TV; **VP9/AV1 in MP4** often does not.
 * - VP9/AV1 stay as last-resort (e.g. desktop VLC), not for iPhone camera roll friendliness.
 */
async function pickVideoEncoderAndMuxerCodec(
  width: number,
  height: number,
  fps: number
): Promise<PickedWebCodecsVideo> {
  const bitrate = Math.max(2_000_000, Math.floor(width * height * fps * 0.12))
  const candidates: { muxerCodec: MuxerVideoCodec; codec: string }[] = [
    { muxerCodec: 'avc', codec: 'avc1.42E01E' },
    { muxerCodec: 'avc', codec: 'avc1.4D401E' },
    { muxerCodec: 'hevc', codec: 'hvc1.1.6.L90.B0' },
    { muxerCodec: 'hevc', codec: 'hvc1.1.6.L93.B0' },
    { muxerCodec: 'hevc', codec: 'hvc1.1.6.L120.B0' },
    { muxerCodec: 'hevc', codec: 'hvc1.1.6.L150.B0' },
    { muxerCodec: 'vp9', codec: 'vp09.00.10.01' },
    { muxerCodec: 'vp9', codec: 'vp09.00.10.08' },
    { muxerCodec: 'vp9', codec: 'vp09.00.41.12' },
    { muxerCodec: 'av1', codec: 'av01.0.04M.08' },
    { muxerCodec: 'av1', codec: 'av01.0.12M.08' },
  ]
  for (const { muxerCodec, codec } of candidates) {
    const base: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate,
      framerate: fps,
    }
    const r = await VideoEncoder.isConfigSupported(base)
    if (r.supported) return { config: (r.config ?? base) as VideoEncoderConfig, muxerCodec }
  }
  throw new Error(
    'This browser has no working WebCodecs video encoder (H.264, HEVC, VP9, or AV1). Update your browser, or on macOS use a recent Chrome/Edge.'
  )
}

/**
 * Renders the virtual-camera view (with the same viewfinder stack as the PiP) to an MP4.
 * Pauses the live Scene loop via `isExporting` while running.
 */
export async function exportMp4(options: ExportMp4Options = {}): Promise<Blob> {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('VideoEncoder is not available in this browser.')
  }

  const ctx = getSceneForExport()
  if (!ctx) throw new Error('3D scene not ready. Wait for the viewport to load.')
  const { remeasurePip } = ctx

  const width = options.width ?? 1920
  const height = options.height ?? 1080
  const fps = options.fps ?? 60
  const store = useEditorStore.getState()
  const duration = options.duration ?? store.duration
  const totalFrames = Math.max(1, Math.ceil(duration * fps))

  const { scene, virtualCamera: vcam, getPostProcessing } = ctx
  const objects = store.objects
  const vcData = store.virtualCamera

  const exportRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
  exportRenderer.setPixelRatio(1)
  exportRenderer.setSize(width, height, false)
  exportRenderer.shadowMap.enabled = true
  exportRenderer.toneMapping = THREE.ACESFilmicToneMapping
  exportRenderer.toneMappingExposure = 1

  vcam.aspect = width / height
  vcam.updateProjectionMatrix()

  const passes = createViewfinderComposer(scene, vcam, exportRenderer, 1)

  const target = new ArrayBufferTarget()
  const { config: encoderConfig, muxerCodec } = await pickVideoEncoderAndMuxerCodec(
    width,
    height,
    fps
  )
  const muxer = new Muxer({
    target,
    video: { codec: muxerCodec, width, height, frameRate: fps },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  })

  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => console.error(e),
  })
  encoder.configure(encoderConfig)

  useEditorStore.getState().setExporting(true)

  try {
    for (let frame = 0; frame < totalFrames; frame++) {
      const t = frame / fps
      applyVirtualCameraAtTime(t, vcData, vcam)
      for (const obj of objects) applyObjectTransformAtTime(t, obj)

      stripViewfinderObjectEffects(objects)
      const stack = getPostProcessing()
      applyViewfinderMeshEffects(objects, stack)
      renderViewfinderFrame(stack, exportRenderer, scene, vcam, passes, 0)

      stripViewfinderObjectEffects(objects)
      for (const obj of objects) applyObjectTransformAtTime(t, obj)
      applyVirtualCameraAtTime(t, vcData, vcam)

      const ts = (frame * 1_000_000) / fps
      const vf = new VideoFrame(exportRenderer.domElement, { timestamp: ts })
      encoder.encode(vf, { keyFrame: frame % fps === 0 })
      vf.close()

      options.onProgress?.((frame + 1) / totalFrames)
    }

    await encoder.flush()
    muxer.finalize()
  } finally {
    remeasurePip()
    useEditorStore.getState().setExporting(false)
    passes.pixelatedPass.dispose()
    passes.bloomPass.dispose()
    passes.ditherPass.dispose()
    passes.outputPass.dispose()
    passes.composer.dispose()
    exportRenderer.dispose()
  }

  return new Blob([target.buffer], { type: 'video/mp4' })
}
