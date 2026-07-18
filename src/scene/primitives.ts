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

/**
 * Stylized low-poly sneaker — the hero product prop. One group so a single
 * spin/float animation moves the whole shoe. ~0.26 units long (tabletop scale),
 * two-tone: body takes `color`, sole stays off-white, ink accents.
 */
export function createSneakerMesh(color = '#FF5A5F'): THREE.Group {
  const g = new THREE.Group()
  const L = STAGE_RADIUS * 0.26 // shoe length
  const body = new THREE.MeshToonMaterial({ color })
  const sole = new THREE.MeshToonMaterial({ color: '#F5F2EA' })
  const ink = new THREE.MeshToonMaterial({ color: '#3B3A48' })

  // Sole slab — full length, slight heel rise via a second wedge.
  const soleMesh = new THREE.Mesh(new THREE.BoxGeometry(L, L * 0.14, L * 0.38), sole)
  soleMesh.position.y = L * 0.07
  g.add(soleMesh)
  const heelWedge = new THREE.Mesh(new THREE.BoxGeometry(L * 0.34, L * 0.1, L * 0.38), sole)
  heelWedge.position.set(-L * 0.33, L * 0.17, 0)
  g.add(heelWedge)

  // Quarter (mid body) and heel counter.
  const quarter = new THREE.Mesh(new THREE.BoxGeometry(L * 0.52, L * 0.3, L * 0.34), body)
  quarter.position.set(-L * 0.16, L * 0.32, 0)
  g.add(quarter)
  const heel = new THREE.Mesh(new THREE.BoxGeometry(L * 0.2, L * 0.42, L * 0.34), body)
  heel.position.set(-L * 0.38, L * 0.36, 0)
  g.add(heel)

  // Toe box — lower, slightly tapered nose.
  const toe = new THREE.Mesh(new THREE.BoxGeometry(L * 0.42, L * 0.2, L * 0.34), body)
  toe.position.set(L * 0.26, L * 0.24, 0)
  toe.rotation.z = -0.08
  g.add(toe)

  // Tongue + collar.
  const tongue = new THREE.Mesh(new THREE.BoxGeometry(L * 0.16, L * 0.22, L * 0.22), body)
  tongue.position.set(L * 0.06, L * 0.44, 0)
  tongue.rotation.z = -0.35
  g.add(tongue)
  const collar = new THREE.Mesh(
    new THREE.TorusGeometry(L * 0.11, L * 0.035, 10, 24, Math.PI),
    ink
  )
  collar.position.set(-L * 0.3, L * 0.56, 0)
  collar.rotation.x = Math.PI / 2
  g.add(collar)

  // Laces — three thin ink bars marching down the instep.
  for (let i = 0; i < 3; i++) {
    const lace = new THREE.Mesh(
      new THREE.BoxGeometry(L * 0.04, L * 0.025, L * 0.26), ink
    )
    lace.position.set(L * (0.2 - i * 0.11), L * (0.36 + i * 0.045), 0)
    lace.rotation.z = -0.3
    g.add(lace)
  }

  // Side stripe accent, both sides.
  for (const side of [-1, 1]) {
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(L * 0.34, L * 0.05, L * 0.012), ink
    )
    stripe.position.set(-L * 0.05, L * 0.26, side * L * 0.172)
    stripe.rotation.z = 0.18
    g.add(stripe)
  }
  return g
}

export function createPrimitiveMesh(
  primitive: 'box' | 'sphere' | 'cone' | 'cylinder' | 'torus' | 'plane' | 'text' | 'sneaker',
  color: string,
  text?: string
): THREE.Mesh | THREE.Group {
  if (primitive === 'text') return createTextTagMesh(text ?? 'TAG', color)
  if (primitive === 'sneaker') return createSneakerMesh(color)
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
