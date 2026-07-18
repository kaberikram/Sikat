/**
 * Builds Three.js meshes for SPAWN_OBJECT packets.
 */
import * as THREE from 'three'
import type { SpawnObjectPayload } from './protocol'
import { createPrimitiveMesh } from '../scene/primitives'

let spawnCounter = 0

const DEFAULT_COLORS: Record<SpawnObjectPayload['primitive'], string> = {
  box: '#FF6B00',
  sphere: '#0094FF',
  cone: '#30d158',
  cylinder: '#bf5af2',
  torus: '#ffd60a',
  plane: '#8e8e93',
  text: '#FF6B00',
  sneaker: '#FF5A5F',
}

export function buildSpawnMesh(payload: SpawnObjectPayload): { mesh: THREE.Mesh | THREE.Group; name: string } {
  const color = payload.color ?? DEFAULT_COLORS[payload.primitive]
  spawnCounter += 1
  const fallbackName = `${payload.primitive.toUpperCase()}_AGT_${String(spawnCounter).padStart(2, '0')}`
  const name = payload.name ?? fallbackName
  const mesh = createPrimitiveMesh(payload.primitive, color, payload.text ?? name)
  return { mesh, name }
}
