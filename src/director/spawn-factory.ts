/**
 * Builds Three.js meshes for SPAWN_OBJECT packets.
 */
import * as THREE from 'three'
import type { SpawnObjectPayload } from './protocol'
import { createPrimitiveMesh } from '../scene/primitives'
import { takePreparedMesh } from './demo-assets'

let spawnCounter = 0

type GeometricPrimitive = Exclude<SpawnObjectPayload['primitive'], 'gltf' | 'image'>

const DEFAULT_COLORS: Record<GeometricPrimitive, string> = {
  box: '#FF6B00',
  sphere: '#0094FF',
  cone: '#30d158',
  cylinder: '#bf5af2',
  torus: '#ffd60a',
  plane: '#8e8e93',
  text: '#FF6B00',
  sneaker: '#FF5A5F',
}

function isGeometric(primitive: SpawnObjectPayload['primitive']): primitive is GeometricPrimitive {
  return primitive !== 'gltf' && primitive !== 'image'
}

export function buildSpawnMesh(payload: SpawnObjectPayload): { mesh: THREE.Mesh | THREE.Group; name: string } {
  spawnCounter += 1
  const fallbackName = `${payload.primitive.toUpperCase()}_AGT_${String(spawnCounter).padStart(2, '0')}`
  const name = payload.name ?? fallbackName
  if (payload.url) {
    const mesh = takePreparedMesh(payload.url)
    if (!mesh) throw new Error(`asset not ready: ${payload.url}`)
    return { mesh, name }
  }
  if (!isGeometric(payload.primitive))
    throw new Error(`asset not ready: ${payload.primitive}`)
  const color = payload.color ?? DEFAULT_COLORS[payload.primitive]
  const mesh = createPrimitiveMesh(payload.primitive, color, payload.text ?? name)
  return { mesh, name }
}
