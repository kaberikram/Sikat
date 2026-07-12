import * as THREE from 'three'
import { createViewfinderComposer } from '../pip-composer'
import { renderViewfinderExportFrame } from '../scene/viewfinder-pass'
import { getSceneForExport } from '../scene-export-registry'
import { useEditorStore } from '../store'
import type { SceneFrame } from './protocol'

interface CaptureOptions {
  maxWidth?: number
  quality?: number
}

function canvasToJpegBase64(
  source: HTMLCanvasElement,
  width: number,
  height: number,
  quality: number
): string | null {
  const jpegCanvas = document.createElement('canvas')
  jpegCanvas.width = width
  jpegCanvas.height = height
  const ctx = jpegCanvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(source, 0, 0, width, height)
  const dataUrl = jpegCanvas.toDataURL('image/jpeg', quality)
  const comma = dataUrl.indexOf(',')
  if (comma === -1) return null
  return dataUrl.slice(comma + 1)
}

export async function captureViewfinderFrame(
  opts?: CaptureOptions
): Promise<SceneFrame | null> {
  const ctx = getSceneForExport()
  if (!ctx) return null

  const maxWidth = opts?.maxWidth ?? 640
  const quality = opts?.quality ?? 0.75
  const store = useEditorStore.getState()
  const { scene, virtualCamera: vcam, getPostProcessing, remeasurePip } = ctx
  const objects = store.objects
  const vcData = store.virtualCamera
  const t = store.currentTime
  const stack = getPostProcessing()

  const prevAspect = vcam.aspect
  const width = maxWidth
  const height = Math.max(1, Math.round(maxWidth / (prevAspect > 0 ? prevAspect : 16 / 9)))

  const exportRenderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: true,
  })
  exportRenderer.setPixelRatio(1)
  exportRenderer.setSize(width, height, false)
  exportRenderer.shadowMap.enabled = true
  exportRenderer.toneMapping = THREE.ACESFilmicToneMapping
  exportRenderer.toneMappingExposure = 1

  vcam.aspect = width / height
  vcam.updateProjectionMatrix()

  const passes = createViewfinderComposer(scene, vcam, exportRenderer, 1)

  // Do not set isExporting — that flag pauses the entire animate loop (including
  // XR). Video export in exporter.ts owns isExporting; JPEG capture must not.
  try {
    renderViewfinderExportFrame(objects, stack, exportRenderer, scene, vcam, passes, t, vcData)
    const base64 = canvasToJpegBase64(exportRenderer.domElement, width, height, quality)
    if (!base64) return null
    return {
      mime: 'image/jpeg',
      width,
      height,
      data: base64,
      capturedAt: Date.now() / 1000,
    }
  } finally {
    vcam.aspect = prevAspect
    vcam.updateProjectionMatrix()
    remeasurePip()
    passes.pixelatedPass.dispose()
    passes.bloomPass.dispose()
    passes.ditherPass.dispose()
    passes.outputPass.dispose()
    passes.composer.dispose()
    exportRenderer.dispose()
  }
}
