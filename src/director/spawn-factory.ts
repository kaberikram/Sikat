/**
 * Builds Three.js meshes for SPAWN_OBJECT packets, mirroring the material and
 * geometry choices of the Editor toolbar (MeshToon, canvas-texture text tags).
 */
import * as THREE from 'three'
import type { SpawnObjectPayload } from './protocol'

let spawnCounter = 0

const DEFAULT_COLORS: Record<SpawnObjectPayload['primitive'], string> = {
  box: '#FF6B00',
  sphere: '#0094FF',
  cone: '#30d158',
  cylinder: '#bf5af2',
  torus: '#ffd60a',
  plane: '#8e8e93',
  text: '#FF6B00',
}

function buildTextMesh(text: string, color: string): THREE.Mesh {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = color
    ctx.font = 'bold 80px "Arial Black"'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.strokeStyle = 'black'
    ctx.lineWidth = 12
    ctx.strokeText(text, 256, 128)
    ctx.fillText(text, 256, 128)
  }
  const texture = new THREE.CanvasTexture(canvas)
  const geometry = new THREE.PlaneGeometry(2, 1)
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
  })
  return new THREE.Mesh(geometry, material)
}

export function buildSpawnMesh(payload: SpawnObjectPayload): { mesh: THREE.Mesh; name: string } {
  const color = payload.color ?? DEFAULT_COLORS[payload.primitive]
  spawnCounter += 1
  const fallbackName = `${payload.primitive.toUpperCase()}_AGT_${String(spawnCounter).padStart(2, '0')}`
  const name = payload.name ?? fallbackName

  if (payload.primitive === 'text') {
    return { mesh: buildTextMesh(payload.text ?? name, color), name }
  }

  let geometry: THREE.BufferGeometry
  switch (payload.primitive) {
    case 'sphere':
      geometry = new THREE.SphereGeometry(0.5, 32, 32)
      break
    case 'cone':
      geometry = new THREE.ConeGeometry(0.5, 1, 32)
      break
    case 'cylinder':
      geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 32)
      break
    case 'torus':
      geometry = new THREE.TorusGeometry(0.5, 0.2, 16, 48)
      break
    case 'plane':
      geometry = new THREE.PlaneGeometry(2, 2)
      break
    case 'box':
    default:
      geometry = new THREE.BoxGeometry(1, 1, 1)
      break
  }
  const material = new THREE.MeshToonMaterial({
    color,
    ...(payload.primitive === 'plane' ? { side: THREE.DoubleSide } : {}),
  })
  return { mesh: new THREE.Mesh(geometry, material), name }
}
