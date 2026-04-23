/**
 * Per-mesh viewfinder-only effects (cell outline, emissive "bloom", glitch jitter).
 * Shared by Scene and exporter must stay in lockstep.
 */
import * as THREE from 'three'
import { createDefaultPostProcessing, type PostProcessingBloom, type PostProcessingStack } from './store'

function forEachMeshMaterial(mesh: THREE.Mesh, fn: (mat: THREE.Material) => void) {
  const m = mesh.material
  if (Array.isArray(m)) m.forEach(fn)
  else fn(m)
}

interface BloomMatUserData {
  bloomSaved?: boolean
  bloomPrevEmissive?: THREE.Color
  bloomPrevIntensity?: number
}

function syncBloomMaterial(mat: THREE.Material, bloom: PostProcessingBloom) {
  if (!('emissive' in mat) || !('color' in mat)) return
  const m = mat as THREE.MeshStandardMaterial
  const u = m.userData as BloomMatUserData
  if (bloom.enabled) {
    if (!u.bloomSaved) {
      u.bloomSaved = true
      u.bloomPrevEmissive = m.emissive.clone()
      u.bloomPrevIntensity = m.emissiveIntensity
    }
    m.emissive.copy(m.color).multiplyScalar(bloom.emissiveBoost)
    m.emissiveIntensity = bloom.emissiveIntensity
  } else if (u.bloomSaved && u.bloomPrevEmissive) {
    m.emissive.copy(u.bloomPrevEmissive)
    m.emissiveIntensity = u.bloomPrevIntensity ?? 0
    delete u.bloomSaved
    delete u.bloomPrevEmissive
    delete u.bloomPrevIntensity
  }
}

const bloomOff: PostProcessingBloom = { ...createDefaultPostProcessing().bloom, enabled: false }

function removeCellOutlinesOnMeshTree(root: THREE.Object3D) {
  root.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return
    const mesh = child as THREE.Mesh
    if (mesh.userData.isCellOutlineShell) return
    if (mesh.userData.outline) {
      mesh.remove(mesh.userData.outline as THREE.Object3D)
      mesh.userData.outline = null
    }
  })
}

function unsyncAllBloomOnMeshTree(root: THREE.Object3D) {
  root.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return
    const mesh = child as THREE.Mesh
    forEachMeshMaterial(mesh, (mat) => syncBloomMaterial(mat, bloomOff))
  })
}

export function stripViewfinderObjectEffects(liveObjects: { mesh?: THREE.Object3D }[]) {
  for (const obj of liveObjects) {
    if (!obj.mesh) continue
    removeCellOutlinesOnMeshTree(obj.mesh)
    unsyncAllBloomOnMeshTree(obj.mesh)
  }
}

export function applyCellOutlines(
  liveObjects: { mesh?: THREE.Object3D }[],
  cell: { enabled: boolean; outlineScale: number }
) {
  if (!cell.enabled) return
  const outlineScale = cell.outlineScale
  for (const obj of liveObjects) {
    if (!obj.mesh) continue
    obj.mesh.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh) return
      const mesh = child as THREE.Mesh
      if (mesh.userData.isCellOutlineShell) return
      if (!mesh.userData.outline) {
        const outlineMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide })
        const outlineMesh = new THREE.Mesh(mesh.geometry, outlineMaterial)
        outlineMesh.scale.setScalar(outlineScale)
        outlineMesh.userData.isCellOutlineShell = true
        mesh.add(outlineMesh)
        mesh.userData.outline = outlineMesh
      } else (mesh.userData.outline as THREE.Mesh).scale.setScalar(outlineScale)
    })
  }
}

export function syncBloomForViewfinder(
  liveObjects: { mesh?: THREE.Object3D }[],
  bloom: PostProcessingBloom
) {
  for (const obj of liveObjects) {
    if (!obj.mesh) continue
    obj.mesh.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh) return
      const mesh = child as THREE.Mesh
      if (mesh.userData.isCellOutlineShell) return
      forEachMeshMaterial(mesh, (mat) => syncBloomMaterial(mat, bloom))
    })
  }
}

export function applyGlitchJitter(
  liveObjects: { mesh?: THREE.Object3D }[],
  gl: { enabled: boolean; intensity: number; rate: number }
) {
  if (!gl.enabled) return
  for (const obj of liveObjects) {
    if (!obj.mesh) continue
    obj.mesh.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh) return
      const mesh = child as THREE.Mesh
      if (mesh.userData.isCellOutlineShell) return
      if (Math.random() < gl.rate)
        mesh.position.x += (Math.random() - 0.5) * gl.intensity
    })
  }
}

/** Apply per-mesh viewfinder pass setup from the camera post stack. */
export function applyViewfinderMeshEffects(
  liveObjects: { mesh?: THREE.Object3D }[],
  stack: PostProcessingStack
) {
  applyCellOutlines(liveObjects, stack.cellShading)
  if (stack.bloom.enabled) syncBloomForViewfinder(liveObjects, stack.bloom)
  if (stack.glitch.enabled) applyGlitchJitter(liveObjects, stack.glitch)
}
