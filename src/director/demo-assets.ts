/**
 * SET DAY hero + backdrop — Breathing Idle mesh, Mixamo run clip, Rat'teryx logo.
 *
 * Preloaded at the start of `startSetDay` so the spawn beats can still go
 * through SPAWN_OBJECT. The mixer is ticked from the animate loop, independent
 * of timeline playback: the clip is a living prop, not a keyframed take.
 *
 * `run clip.glb` is animation-only (no mesh). The visible body is
 * `Breathing Idle.glb`; the run is retargeted onto that Mixamo rig.
 * The Meshy PNG replaces every GLB material via the ticweb recipe
 * (`flatMaterialFromSource`): colorSpace sRGB only. Do not set flipY — this
 * PNG is authored for TextureLoader's default (true).
 */
import * as THREE from 'three'
import { gltfLoader } from '../gltf-loader'

const BASE = import.meta.env.BASE_URL

export const HERO_URL = `${BASE}draco/Stage%20Assets/Breathing%20Idle.glb`
const RUN_CLIP_URL = `${BASE}draco/Stage%20Assets/run%20clip.glb`
const HERO_TEXTURE_URL = `${BASE}draco/Stage%20Assets/Meshy_AI_Midnight_All_Weather__0506013432_texture.png`
export const SIGN_URL = `${BASE}draco/Stage%20Assets/rateryxLogo.png`

/** Pedestal top is ~0.54 m across; leave a rim so the clip sits on it. */
const HERO_FOOTPRINT_M = 0.42
const HERO_MAX_HEIGHT_M = 0.6
const SIGN_WIDTH_M = 0.7
const HERO_TINT = 0xdcdcdc

const prepared = new Map<string, THREE.Mesh | THREE.Group>()
let mixer: THREE.AnimationMixer | null = null
let loadPromise: Promise<void> | null = null

const textureLoader = new THREE.TextureLoader()

export function preloadDemoAssets(): Promise<void> {
  if (prepared.has(HERO_URL) && prepared.has(SIGN_URL)) return Promise.resolve()
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    const [hero, sign] = await Promise.all([loadHero(), loadSign()])
    prepared.set(HERO_URL, hero)
    prepared.set(SIGN_URL, sign)
  })().finally(() => {
    loadPromise = null
  })
  return loadPromise
}

/** One-shot: the mesh leaves the cache so a later spawn cannot share it. */
export function takePreparedMesh(url: string): THREE.Mesh | THREE.Group | null {
  const mesh = prepared.get(url) ?? null
  if (mesh) prepared.delete(url)
  return mesh
}

export function tickDemoAssets(delta: number): void {
  mixer?.update(delta)
}

export function disposeDemoAssets(): void {
  mixer?.stopAllAction()
  mixer = null
  prepared.clear()
  loadPromise = null
}

async function loadHero(): Promise<THREE.Group> {
  const [modelGltf, clipGltf, albedo] = await Promise.all([
    gltfLoader.loadAsync(HERO_URL),
    gltfLoader.loadAsync(RUN_CLIP_URL),
    textureLoader.loadAsync(HERO_TEXTURE_URL),
  ])
  albedo.colorSpace = THREE.SRGBColorSpace

  const inner = modelGltf.scene
  applyPlayerMaterials(inner, albedo)
  inner.rotation.y = Math.PI
  inner.updateMatrixWorld(true)

  const box = new THREE.Box3().setFromObject(inner)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  inner.position.x -= center.x
  inner.position.z -= center.z
  inner.position.y -= box.min.y

  const foot = Math.max(size.x, size.z)
  const sFoot = foot > 1e-6 ? HERO_FOOTPRINT_M / foot : 1
  const sHeight = size.y > 1e-6 ? HERO_MAX_HEIGHT_M / size.y : 1
  const s = Math.min(sFoot, sHeight)

  // Fit scale lives on a child group so the store can own wrapper.scale
  // (timeline-apply overwrites mesh.scale every frame).
  const sized = new THREE.Group()
  sized.scale.setScalar(Number.isFinite(s) && s > 0 ? s : 1)
  sized.add(inner)

  const wrapper = new THREE.Group()
  wrapper.add(sized)

  mixer?.stopAllAction()
  mixer = new THREE.AnimationMixer(inner)
  const source = clipGltf.animations.find((a) => a.name === 'mixamo.com') ?? clipGltf.animations[0]
  if (source) {
    const clip = prepareSeamlessRunClip(remapGlbClipToPlayerRig(source))
    const action = mixer.clipAction(clip)
    action.setLoop(THREE.LoopRepeat, Infinity)
    action.play()
    mixer.update(0)
  }
  plantFeetOnOrigin(wrapper, inner, sized.scale.y)

  return wrapper
}

/**
 * Same as ticweb `applyPlayerMaterialsAndFit` / `flatMaterialFromSource`.
 * Shared PNG, throw away embedded maps/vertex colors, keep source side/opacity.
 */
function applyPlayerMaterials(root: THREE.Object3D, outfitDiffuse: THREE.Texture): void {
  outfitDiffuse.colorSpace = THREE.SRGBColorSpace
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    const mats = Array.isArray(child.material) ? child.material : [child.material]
    const next = mats.map((m) => flatMaterialFromSource(child, m, outfitDiffuse))
    child.material = next.length === 1 ? next[0] : next
    child.castShadow = true
    if (child instanceof THREE.SkinnedMesh) child.frustumCulled = false
  })
}

function flatMaterialFromSource(
  child: THREE.Mesh,
  src: THREE.Material | undefined,
  sharedDiffuse: THREE.Texture
): THREE.MeshStandardMaterial {
  const srcStd = src as THREE.MeshStandardMaterial | undefined
  sharedDiffuse.colorSpace = THREE.SRGBColorSpace
  return new THREE.MeshStandardMaterial({
    map: sharedDiffuse,
    color: new THREE.Color(HERO_TINT),
    roughness: 0.82,
    metalness: 0.04,
    vertexColors: false,
    transparent: false,
    opacity: srcStd && srcStd.opacity != null ? srcStd.opacity : 1,
    side: srcStd && srcStd.side != null ? srcStd.side : THREE.FrontSide,
    alphaTest: 0,
  })
}

/**
 * Mixamo clip GLBs name bones `mixamorigHips`.
 * The idle mesh names them `mixamorig_Hips`. Same rig, different separator.
 */
function remapGlbClipToPlayerRig(source: THREE.AnimationClip): THREE.AnimationClip {
  const out = source.clone()
  for (const track of out.tracks) {
    if (/^mixamorig[^._]/.test(track.name))
      track.name = track.name.replace(/^mixamorig/, 'mixamorig_')
  }
  return out
}

/** Podium loop from ticweb: lock hips XZ and seam the last frame to the first. */
function prepareSeamlessRunClip(sourceClip: THREE.AnimationClip): THREE.AnimationClip {
  const clip = sourceClip.clone()
  for (const track of clip.tracks) {
    const values = track.values
    const valueSize = track.getValueSize()
    if (track.times.length < 2 || values.length < valueSize * 2) continue
    if (/\.position$/.test(track.name) && /hips|root/i.test(track.name.replace(/[:.]/g, ''))) {
      const x0 = values[0]
      const z0 = values[2]
      for (let i = 0; i < values.length; i += 3) {
        values[i] = x0
        values[i + 2] = z0
      }
    }
    const lastIdx = track.times.length - 1
    for (let j = 0; j < valueSize; j++)
      values[lastIdx * valueSize + j] = values[j]
  }
  let maxEnd = 0
  for (const track of clip.tracks) {
    const lastTime = track.times[track.times.length - 1]
    if (lastTime > maxEnd) maxEnd = lastTime
  }
  if (maxEnd > 0) clip.duration = maxEnd
  return clip
}

/**
 * Idle-pose Box3 sits the bind feet on the origin; the run clip then lifts
 * the hips. Bone world Y after frame 0 is the real sole — drop until it hits 0
 * so `on PEDESTAL` puts the runner on the cylinder, not hovering over it.
 */
function plantFeetOnOrigin(wrapper: THREE.Object3D, inner: THREE.Object3D, fitScale: number): void {
  wrapper.updateMatrixWorld(true)
  const scratch = new THREE.Vector3()
  let minY = Infinity
  inner.traverse((node) => {
    if (!/Foot$|ToeBase$|Toe_End$/i.test(node.name)) return
    node.getWorldPosition(scratch)
    if (scratch.y < minY) minY = scratch.y
  })
  if (!Number.isFinite(minY) || Math.abs(minY) < 1e-4) return
  const s = fitScale > 1e-6 ? fitScale : 1
  inner.position.y -= minY / s
}

async function loadSign(): Promise<THREE.Mesh> {
  const texture = await textureLoader.loadAsync(SIGN_URL)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.needsUpdate = true
  const img = texture.image as { width: number; height: number }
  const aspect = img.height > 0 ? img.width / img.height : 1
  const height = SIGN_WIDTH_M / aspect
  return new THREE.Mesh(
    new THREE.PlaneGeometry(SIGN_WIDTH_M, height),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: THREE.DoubleSide,
    })
  )
}
