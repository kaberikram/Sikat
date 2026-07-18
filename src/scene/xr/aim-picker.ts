/**
 * Point + speak: the camcorder's aim ray becomes a real pointer.
 *
 * Throttled raycast from the camcorder aim pose against live scene objects;
 * whatever you're aiming at is remembered so "make THIS gold" targets exactly
 * that object — the hint rides the command to the server, no guessing.
 */
import * as THREE from 'three'
import { beatTick } from '../../director/sound'
import { useEditorStore } from '../../store'

const PICK_INTERVAL_MS = 100
const RAY_LEN = 4

const raycaster = new THREE.Raycaster()
raycaster.far = RAY_LEN

let aimedId: string | null = null
let aimedName: string | null = null
let lastPick = 0
let onChange: ((id: string | null, name: string | null) => void) | null = null

export function getAimedObject(): { id: string; name: string } | null {
  return aimedId && aimedName ? { id: aimedId, name: aimedName } : null
}

/** One listener (the rig) — fires on hover change for lock-on feedback. */
export function setAimChangeListener(fn: ((id: string | null, name: string | null) => void) | null): void {
  onChange = fn
}

function resolveObjectId(node: THREE.Object3D): string | null {
  let cur: THREE.Object3D | null = node
  while (cur) {
    if (cur.userData?.isSceneInfrastructure) return null
    const id = cur.userData?.id as string | undefined
    if (id) return id
    cur = cur.parent
  }
  return null
}

/** Called from the rig's per-frame update with the camcorder aim pose. */
export function updateAimPick(origin: THREE.Vector3, quat: THREE.Quaternion, nowMs: number): void {
  if (nowMs - lastPick < PICK_INTERVAL_MS) return
  lastPick = nowMs

  const objects = useEditorStore.getState().objects
  const roots: THREE.Object3D[] = []
  for (const obj of objects) if (obj.mesh) roots.push(obj.mesh)

  let hitId: string | null = null
  if (roots.length > 0) {
    raycaster.ray.origin.copy(origin)
    raycaster.ray.direction.set(0, 0, -1).applyQuaternion(quat).normalize()
    const hits = raycaster.intersectObjects(roots, true)
    for (const hit of hits) {
      const id = resolveObjectId(hit.object)
      if (id) {
        hitId = id
        break
      }
    }
  }

  if (hitId !== aimedId) {
    aimedId = hitId
    aimedName = hitId ? (objects.find((o) => o.id === hitId)?.name ?? null) : null
    if (aimedId) beatTick()
    onChange?.(aimedId, aimedName)
  }
}

export function clearAimPick(): void {
  if (aimedId !== null) {
    aimedId = null
    aimedName = null
    onChange?.(null, null)
  }
}
