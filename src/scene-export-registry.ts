import * as THREE from 'three'
import { createViewfinderComposer } from './pip-composer'
import type { PostProcessingStack } from './store'

export interface SceneExportContext {
  scene: THREE.Scene
  virtualCamera: THREE.PerspectiveCamera
  getPostProcessing: () => PostProcessingStack
  viewfinder: ReturnType<typeof createViewfinderComposer> & { renderer: THREE.WebGLRenderer }
  /** Restore virtual camera + composer size to the PiP after an export changes aspect. */
  remeasurePip: () => void
}

let context: SceneExportContext | null = null

export function registerSceneForExport(c: SceneExportContext | null) {
  context = c
}

export function getSceneForExport() {
  return context
}
