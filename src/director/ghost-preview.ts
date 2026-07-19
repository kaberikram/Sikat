/**
 * Ghost previews — the set shows what it UNDERSTOOD before it commits.
 *
 * The server's intent_preview lands ~100-300ms after you stop talking, long
 * before the full parse finishes. For spatial intents we render a translucent
 * mint silhouette of the outcome: the primitive about to spawn, or the target
 * object at its destination. The real change replaces the ghost; a wrong
 * ghost can be corrected by speaking before anything lands.
 *
 * Ghosts live on EDITOR_LAYER — the director sees them, the film never does.
 */
import * as THREE from 'three'
import { getSceneForExport } from '../scene-export-registry'
import { setEditorLayer, tagSceneInfrastructure } from '../scene/infrastructure'
import { createPrimitiveMesh } from '../scene/primitives'
import { resolveTarget } from './command-applier'
import { sampleObjectAtTime } from './scene-state-sync'
import { beatTick } from './sound'
import { useEditorStore } from '../store'
import type { IntentPreviewMessage, Vec3 } from './protocol'

const GHOST_TTL_MS = 5000
const GHOST_COLOR = '#57CFA0'

interface Ghost {
  root: THREE.Object3D
  material: THREE.MeshBasicMaterial
  /** Spawn ghosts own their geometry (freshly built); transform ghosts share
   *  the live object's geometry and must never dispose it. */
  ownsGeometry: boolean
  expireTimer: ReturnType<typeof setTimeout>
}

const ghosts = new Map<string, Ghost>()

function makeGhostMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: GHOST_COLOR,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  })
}

/** Clone a mesh tree with every material swapped for the shared ghost material.
 *  Geometry stays shared by reference — never dispose it from the ghost. */
function ghostClone(source: THREE.Object3D, material: THREE.MeshBasicMaterial): THREE.Object3D {
  const clone = source.clone(true)
  clone.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (mesh.isMesh) {
      mesh.material = material
      mesh.castShadow = false
      mesh.receiveShadow = false
    }
  })
  return clone
}

function mountGhost(
  commandId: string,
  root: THREE.Object3D,
  material: THREE.MeshBasicMaterial,
  ownsGeometry: boolean
): void {
  const scene = getSceneForExport()?.scene
  if (!scene) return
  clearGhost(commandId)
  tagSceneInfrastructure(root)
  setEditorLayer(root)
  root.renderOrder = 8
  scene.add(root)
  ghosts.set(commandId, {
    root,
    material,
    ownsGeometry,
    expireTimer: setTimeout(() => clearGhost(commandId), GHOST_TTL_MS),
  })
  beatTick()
}

export function showGhost(msg: IntentPreviewMessage): void {
  if (msg.action === 'spawn' && msg.primitive) {
    const material = makeGhostMaterial()
    const root = createPrimitiveMesh(msg.primitive, GHOST_COLOR)
    root.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (mesh.isMesh) mesh.material = material
    })
    const stage = useEditorStore.getState().stage
    const pos: Vec3 = msg.position ?? [
      stage.position[0],
      stage.position[1] + 0.5,
      stage.position[2],
    ]
    root.position.set(pos[0], pos[1], pos[2])
    mountGhost(msg.commandId, root, material, true)
    return
  }

  if (msg.action === 'transform' && msg.target && (msg.position || msg.rotation || msg.scale)) {
    const obj = resolveTarget({ name: msg.target })
    if (!obj?.mesh) return
    const st = useEditorStore.getState()
    const sampled = sampleObjectAtTime(obj, st.currentTime)
    const material = makeGhostMaterial()
    const root = ghostClone(obj.mesh, material)

    let pos: Vec3 = sampled.position
    if (msg.position) {
      pos = msg.mode === 'absolute'
        ? msg.position
        : [
            sampled.position[0] + msg.position[0],
            sampled.position[1] + msg.position[1],
            sampled.position[2] + msg.position[2],
          ]
    }
    root.position.set(pos[0], pos[1], pos[2])

    let rot: Vec3 = sampled.rotation
    if (msg.rotation) {
      // Relative rotation is additive, same as position (command-applier's combine()).
      rot = msg.mode === 'absolute'
        ? msg.rotation
        : [
            sampled.rotation[0] + msg.rotation[0],
            sampled.rotation[1] + msg.rotation[1],
            sampled.rotation[2] + msg.rotation[2],
          ]
    }
    root.rotation.set(rot[0], rot[1], rot[2])

    let scale: Vec3 = sampled.scale
    if (msg.scale) {
      scale = msg.mode === 'absolute'
        ? msg.scale
        : [
            sampled.scale[0] * msg.scale[0],
            sampled.scale[1] * msg.scale[1],
            sampled.scale[2] * msg.scale[2],
          ]
    }
    root.scale.set(scale[0], scale[1], scale[2])
    mountGhost(msg.commandId, root, material, false)
  }
}

export function clearGhost(commandId: string | null | undefined): void {
  if (!commandId) return
  const ghost = ghosts.get(commandId)
  if (!ghost) return
  ghosts.delete(commandId)
  clearTimeout(ghost.expireTimer)
  ghost.root.removeFromParent()
  if (ghost.ownsGeometry) {
    ghost.root.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (mesh.isMesh) mesh.geometry.dispose()
    })
  }
  ghost.material.dispose()
}

export function clearAllGhosts(): void {
  for (const commandId of [...ghosts.keys()]) clearGhost(commandId)
}
