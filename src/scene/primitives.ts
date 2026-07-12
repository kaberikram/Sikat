import * as THREE from 'three'
import { STAGE_RADIUS } from '../store'

/** Prop sizes for the queen-bed stage (~2m diameter). Absolute meters in XR. */
const PROP = {
  sphereR: STAGE_RADIUS * 0.15,
  box: STAGE_RADIUS * 0.28,
  coneR: STAGE_RADIUS * 0.15,
  coneH: STAGE_RADIUS * 0.3,
  cylR: STAGE_RADIUS * 0.15,
  cylH: STAGE_RADIUS * 0.3,
  torusR: STAGE_RADIUS * 0.15,
  torusTube: STAGE_RADIUS * 0.05,
  plane: STAGE_RADIUS * 0.5,
  textW: STAGE_RADIUS * 0.5,
  textH: STAGE_RADIUS * 0.25,
} as const

export function createBoxMesh(color = '#FF6B00'): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.BoxGeometry(PROP.box, PROP.box, PROP.box),
    new THREE.MeshToonMaterial({ color })
  )
}

export function createSphereMesh(color = '#0094FF'): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.SphereGeometry(PROP.sphereR, 32, 32),
    new THREE.MeshToonMaterial({ color })
  )
}

export function createTextTagMesh(text = 'JET!', color = '#FF6B00'): THREE.Mesh {
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
  return new THREE.Mesh(
    new THREE.PlaneGeometry(PROP.textW, PROP.textH),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide })
  )
}

export function createPrimitiveMesh(
  primitive: 'box' | 'sphere' | 'cone' | 'cylinder' | 'torus' | 'plane' | 'text',
  color: string,
  text?: string
): THREE.Mesh {
  if (primitive === 'text') return createTextTagMesh(text ?? 'TAG', color)
  if (primitive === 'box') return createBoxMesh(color)
  if (primitive === 'sphere') return createSphereMesh(color)

  let geometry: THREE.BufferGeometry
  switch (primitive) {
    case 'cone':
      geometry = new THREE.ConeGeometry(PROP.coneR, PROP.coneH, 32)
      break
    case 'cylinder':
      geometry = new THREE.CylinderGeometry(PROP.cylR, PROP.cylR, PROP.cylH, 32)
      break
    case 'torus':
      geometry = new THREE.TorusGeometry(PROP.torusR, PROP.torusTube, 16, 48)
      break
    case 'plane':
      geometry = new THREE.PlaneGeometry(PROP.plane, PROP.plane)
      break
    default:
      geometry = new THREE.BoxGeometry(PROP.box, PROP.box, PROP.box)
  }
  return new THREE.Mesh(
    geometry,
    new THREE.MeshToonMaterial({
      color,
      ...(primitive === 'plane' ? { side: THREE.DoubleSide } : {}),
    })
  )
}
