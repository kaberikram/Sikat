/**
 * Voice undo — "undo that" reverts the last command wholesale.
 *
 * One snapshot per commandId (a multi-packet command — or the whole SET DAY
 * build — is a single undo unit), captured before the first packet mutates
 * anything. Snapshots keep live mesh references (removeObject/prune never
 * dispose meshes, so restored objects re-enter the scene via the animate
 * loop's reconciliation), plus per-material paint state because SET_MATERIAL
 * mutates mesh materials directly.
 */
import * as THREE from 'three'
import { useEditorStore, type MotionObject, type SceneLighting, type VirtualCamera } from '../store'

const MAX_UNDO = 10

interface MaterialPaint {
  color: string
  emissive: string | null
  emissiveIntensity: number | null
  opacity: number
  transparent: boolean
}

interface UndoEntry {
  commandId: string
  text: string | null
  objects: MotionObject[]
  lighting: SceneLighting
  virtualCamera: VirtualCamera
  duration: number
  /** mesh uuid → paint, for every object alive at capture time. */
  paint: Map<string, MaterialPaint>
}

const stack: UndoEntry[] = []
const commandTexts = new Map<string, string>()

export function noteCommandText(commandId: string, text: string): void {
  commandTexts.set(commandId, text)
  if (commandTexts.size > 50) {
    const first = commandTexts.keys().next().value
    if (first) commandTexts.delete(first)
  }
}

function capturePaint(objects: MotionObject[]): Map<string, MaterialPaint> {
  const paint = new Map<string, MaterialPaint>()
  for (const obj of objects) {
    obj.mesh?.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh || mesh.userData.isCellOutlineShell) return
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const m = materials[0] as THREE.MeshStandardMaterial
      if (!m || !('color' in m) || !m.color) return
      paint.set(mesh.uuid, {
        color: `#${m.color.getHexString()}`,
        emissive: 'emissive' in m && m.emissive ? `#${m.emissive.getHexString()}` : null,
        emissiveIntensity: 'emissiveIntensity' in m ? m.emissiveIntensity : null,
        opacity: m.opacity,
        transparent: m.transparent,
      })
    })
  }
  return paint
}

function restorePaint(objects: MotionObject[], paint: Map<string, MaterialPaint>): void {
  for (const obj of objects) {
    obj.mesh?.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      const saved = paint.get(mesh.uuid)
      if (!saved) return
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const raw of materials) {
        const m = raw as THREE.MeshStandardMaterial
        if ('color' in m && m.color) m.color.set(saved.color)
        if (saved.emissive !== null && 'emissive' in m && m.emissive) m.emissive.set(saved.emissive)
        if (saved.emissiveIntensity !== null && 'emissiveIntensity' in m) {
          m.emissiveIntensity = saved.emissiveIntensity
        }
        m.opacity = saved.opacity
        m.transparent = saved.transparent
      }
    })
  }
}

function snapshotObjects(objects: MotionObject[]): MotionObject[] {
  return objects.map((o) => ({
    ...o,
    position: [...o.position] as MotionObject['position'],
    rotation: [...o.rotation] as MotionObject['rotation'],
    scale: [...o.scale] as MotionObject['scale'],
    keyframes: o.keyframes.map((k) => ({ ...k })),
    materialOverride: o.materialOverride ? { ...o.materialOverride } : o.materialOverride,
  }))
}

/** Snapshot the undoable slice once per command, before the first mutation. */
export function captureBefore(commandId: string): void {
  if (stack.some((entry) => entry.commandId === commandId)) return
  const st = useEditorStore.getState()
  stack.push({
    commandId,
    text: commandTexts.get(commandId) ?? null,
    objects: snapshotObjects(st.objects),
    lighting: JSON.parse(JSON.stringify(st.lighting)) as SceneLighting,
    virtualCamera: {
      ...st.virtualCamera,
      position: [...st.virtualCamera.position] as VirtualCamera['position'],
      rotation: [...st.virtualCamera.rotation] as VirtualCamera['rotation'],
      keyframes: st.virtualCamera.keyframes.map((k) => ({ ...k })),
      postProcessing: JSON.parse(JSON.stringify(st.virtualCamera.postProcessing)),
    },
    duration: st.duration,
    paint: capturePaint(st.objects),
  })
  if (stack.length > MAX_UNDO) stack.shift()
}

/** Revert to before the newest captured command. Returns a summary, or null. */
export function undoLast(): string | null {
  const entry = stack.pop()
  if (!entry) return null
  useEditorStore.setState({
    objects: entry.objects,
    lighting: entry.lighting,
    virtualCamera: entry.virtualCamera,
    duration: entry.duration,
  })
  restorePaint(entry.objects, entry.paint)
  return entry.text ? `undone — back to before “${entry.text}”` : 'undone'
}

export function canUndo(): boolean {
  return stack.length > 0
}
