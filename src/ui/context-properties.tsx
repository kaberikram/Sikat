import React, { useMemo, useState } from 'react'
import * as THREE from 'three'
import {
  useEditorStore,
  VIRTUAL_CAMERA_ID,
  type MotionObject,
  type PostProcessingStack,
} from '../store'
import { buildTurnaroundRotationKeyframes } from '../animation-presets'
import { patchCameraPostSection, type PostSectionId } from '../post-processing'
import { Button } from './button'
import { PostStackEditor } from './post-stack-editor'

function collectDescendantMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = []
  root.traverse((c) => {
    if (c instanceof THREE.Mesh) out.push(c)
  })
  return out
}

function getEffectiveMeshTransparent(
  mesh: THREE.Mesh,
  overrides: Record<string, boolean> | undefined
): boolean {
  const o = overrides?.[mesh.uuid]
  if (o !== undefined) return o
  const m = mesh.material
  const list = Array.isArray(m) ? m : [m]
  return list.some((x) => x.transparent)
}

function getEffectiveMeshShadow(
  mesh: THREE.Mesh,
  overrides: Record<string, boolean> | undefined
): boolean {
  return overrides?.[mesh.uuid] !== false
}

function VectorFields({
  label,
  values,
  onChange,
}: {
  label: string
  values: [number, number, number]
  onChange: (next: [number, number, number]) => void
}) {
  return (
    <div>
      <div className="text-[10px] font-semibold text-ink-soft mb-1">{label}</div>
      <div className="grid grid-cols-3 gap-1">
        {[0, 1, 2].map((i) => (
          <input
            key={i}
            type="number"
            value={values[i]}
            onChange={(e) => {
              const v = parseFloat(e.target.value)
              if (Number.isNaN(v)) return
              const next = [...values] as [number, number, number]
              next[i] = v
              onChange(next)
            }}
            className="w-full rounded-[10px] bg-white/70 border border-line p-1 text-[10px] font-mono font-bold outline-none focus:ring-2 focus:ring-candy-blue"
          />
        ))}
      </div>
    </div>
  )
}

export function ContextProperties() {
  const selectedId = useEditorStore((s) => s.selectedId)
  const objects = useEditorStore((s) => s.objects)
  const virtualCamera = useEditorStore((s) => s.virtualCamera)
  const currentTime = useEditorStore((s) => s.currentTime)
  const duration = useEditorStore((s) => s.duration)
  const updateObject = useEditorStore((s) => s.updateObject)
  const updateCamera = useEditorStore((s) => s.updateCamera)
  const addKeyframe = useEditorStore((s) => s.addKeyframe)
  const addCameraKeyframe = useEditorStore((s) => s.addCameraKeyframe)
  const setObjectPropertyKeyframes = useEditorStore((s) => s.setObjectPropertyKeyframes)
  const setTime = useEditorStore((s) => s.setTime)
  const setSubMeshTransparent = useEditorStore((s) => s.setSubMeshTransparent)
  const setSubMeshShadow = useEditorStore((s) => s.setSubMeshShadow)
  const snapshotObjectKeyframes = useEditorStore((s) => s.snapshotObjectKeyframes)
  const snapshotCameraKeyframes = useEditorStore((s) => s.snapshotCameraKeyframes)

  const [openSections, setOpenSections] = useState<Partial<Record<PostSectionId, boolean>>>({})
  const selected = objects.find((o) => o.id === selectedId)
  const cameraMode = selectedId === VIRTUAL_CAMERA_ID

  const subMeshes = useMemo(
    () => (selected?.mesh ? collectDescendantMeshes(selected.mesh) : []),
    [selected?.mesh, selected?.id]
  )

  if (!selectedId) return null

  const patchSection = (section: PostSectionId, patch: Partial<PostProcessingStack[typeof section]>) => {
    const vc = useEditorStore.getState().virtualCamera
    updateCamera(patchCameraPostSection(vc, section, patch))
  }

  function commitObjectVector(
    obj: MotionObject,
    property: 'position' | 'rotation' | 'scale',
    value: [number, number, number]
  ) {
    updateObject(obj.id, { [property]: value })
    if (obj.keyframes.some((k) => k.property === property))
      addKeyframe(obj.id, currentTime, property, value)
  }

  function commitCameraVector(property: 'position' | 'rotation', value: [number, number, number]) {
    updateCamera({ [property]: value })
    if (virtualCamera.keyframes.some((k) => k.property === property))
      addCameraKeyframe(currentTime, property, value)
  }

  function commitCameraFov(value: number) {
    updateCamera({ fov: value })
    if (virtualCamera.keyframes.some((k) => k.property === 'fov'))
      addCameraKeyframe(currentTime, 'fov', [value, 0, 0])
  }

  if (cameraMode) {
    return (
      <div className="flex flex-col gap-2 max-h-52 overflow-y-auto pr-1">
        <div className="text-[11px] font-bold text-ink-soft">Viewfinder / Lens</div>
        <VectorFields
          label="POSITION"
          values={virtualCamera.position}
          onChange={(v) => commitCameraVector('position', v)}
        />
        <VectorFields
          label="ROTATION"
          values={virtualCamera.rotation}
          onChange={(v) => commitCameraVector('rotation', v)}
        />
        <label className="text-[10px] font-semibold text-ink-soft block">
          FOV
          <input
            type="number"
            value={virtualCamera.fov}
            onChange={(e) => {
              const v = parseFloat(e.target.value)
              if (!Number.isNaN(v)) commitCameraFov(v)
            }}
            className="w-full rounded-[10px] bg-white/70 border border-line p-1 text-[10px] font-mono font-bold text-ink outline-none focus:ring-2 focus:ring-candy-blue mt-0.5"
          />
        </label>
        <Button variant="dark" size="sm" onClick={() => snapshotCameraKeyframes(currentTime)} className="w-full">
          ADD_KEYFRAME
        </Button>
        <span className="text-[11px] font-mono font-bold">POST_STACK</span>
        <PostStackEditor
          openSections={openSections}
          setOpenSections={setOpenSections}
          selected={virtualCamera}
          patchSection={patchSection}
          updateSectionSlider={(section, key, v) => {
            patchSection(section, { [key]: v } as Partial<PostProcessingStack[typeof section]>)
          }}
          updateSectionToggle={(section, key) => {
            const c = virtualCamera.postProcessing[section] as unknown as Record<string, boolean>
            patchSection(section, { [key]: !c[key] } as Partial<PostProcessingStack[typeof section]>)
          }}
        />
      </div>
    )
  }

  if (!selected) return null

  return (
    <div className="flex flex-col gap-2 max-h-52 overflow-y-auto pr-1">
      <div className="text-[11px] font-bold truncate">{selected.name}</div>
      <VectorFields
        label="POSITION"
        values={selected.position}
        onChange={(v) => commitObjectVector(selected, 'position', v)}
      />
      <VectorFields
        label="ROTATION"
        values={selected.rotation}
        onChange={(v) => commitObjectVector(selected, 'rotation', v)}
      />
      <VectorFields
        label="SCALE"
        values={selected.scale}
        onChange={(v) => commitObjectVector(selected, 'scale', v)}
      />
      <Button
        variant="dark"
        size="sm"
        onClick={() => snapshotObjectKeyframes(selected.id, currentTime)}
        className="w-full"
      >
        ADD_KEYFRAME
      </Button>
      <Button
        variant="pink"
        size="sm"
        onClick={() => {
          const kfs = buildTurnaroundRotationKeyframes(selected.rotation, duration)
          setObjectPropertyKeyframes(selected.id, 'rotation', kfs)
          setTime(0)
        }}
        className="w-full"
      >
        360_TURNAROUND
      </Button>
      {subMeshes.length > 0 && (
        <div className="fx-row pt-2">
          <div className="text-[11px] font-semibold block mb-2">
            MESHES
            <div className="text-[9px] font-mono font-bold opacity-60 mt-0.5 flex justify-end gap-3">
              <span>α</span>
              <span>SHD</span>
            </div>
          </div>
          <ul className="flex flex-col gap-1.5 max-h-24 overflow-y-auto pr-0.5">
            {subMeshes.map((m, i) => (
              <li key={m.uuid} className="grid grid-cols-[1fr_auto_auto] items-center gap-2 min-h-[22px]">
                <span className="text-[10px] font-mono font-bold truncate min-w-0" title={m.name || `Mesh ${i + 1}`}>
                  {m.name || `MESH_${i + 1}`}
                </span>
                <label className="flex items-center justify-center text-[8px] cursor-pointer" title="Transparent">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded accent-[var(--color-candy-mint-deep)]"
                    checked={getEffectiveMeshTransparent(m, selected.subMeshTransparent)}
                    onChange={(e) => setSubMeshTransparent(selected.id, m.uuid, e.target.checked)}
                  />
                </label>
                <label className="flex items-center justify-center text-[8px] cursor-pointer" title="Cast and receive shadows">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded accent-[var(--color-candy-mint-deep)]"
                    checked={getEffectiveMeshShadow(m, selected.subMeshShadow)}
                    onChange={(e) => setSubMeshShadow(selected.id, m.uuid, e.target.checked)}
                  />
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
