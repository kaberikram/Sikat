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

/**
 * Persistent offscreen renderer + composer, reused across captures.
 * Creating a WebGL context per frame grab cost tens of ms and risked
 * Chromium's live-context cap when vision commands overlapped.
 */
let captureRenderer: THREE.WebGLRenderer | null = null
let capturePasses: ReturnType<typeof createViewfinderComposer> | null = null
let captureScene: THREE.Scene | null = null
let captureCam: THREE.PerspectiveCamera | null = null

function getCaptureRenderer(width: number, height: number): THREE.WebGLRenderer {
  if (!captureRenderer) {
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
    })
    renderer.setPixelRatio(1)
    renderer.shadowMap.enabled = true
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1
    renderer.domElement.addEventListener('webglcontextlost', () => {
      // Next capture recreates from scratch.
      capturePasses?.composer.dispose()
      capturePasses = null
      captureScene = null
      captureCam = null
      captureRenderer = null
    })
    captureRenderer = renderer
  }
  const size = new THREE.Vector2()
  captureRenderer.getSize(size)
  if (size.x !== width || size.y !== height) {
    captureRenderer.setSize(width, height, false)
  }
  return captureRenderer
}

function getCapturePasses(
  scene: THREE.Scene,
  vcam: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer
): ReturnType<typeof createViewfinderComposer> {
  if (!capturePasses || captureScene !== scene || captureCam !== vcam) {
    capturePasses?.composer.dispose()
    capturePasses = createViewfinderComposer(scene, vcam, renderer, 1)
    captureScene = scene
    captureCam = vcam
  }
  return capturePasses
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

  const exportRenderer = getCaptureRenderer(width, height)

  vcam.aspect = width / height
  vcam.updateProjectionMatrix()

  const passes = getCapturePasses(scene, vcam, exportRenderer)
  if (passes.composerWidth !== width || passes.composerHeight !== height) {
    passes.composer.setSize(width, height)
    passes.composerWidth = width
    passes.composerHeight = height
  }

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
  }
}
