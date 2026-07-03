import * as THREE from 'three'

export function createBoxMesh(color = '#FF6B00'): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshToonMaterial({ color })
  )
}

export function createSphereMesh(color = '#0094FF'): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 32, 32),
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
    new THREE.PlaneGeometry(2, 1),
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
    default:
      geometry = new THREE.BoxGeometry(1, 1, 1)
  }
  return new THREE.Mesh(
    geometry,
    new THREE.MeshToonMaterial({
      color,
      ...(primitive === 'plane' ? { side: THREE.DoubleSide } : {}),
    })
  )
}
