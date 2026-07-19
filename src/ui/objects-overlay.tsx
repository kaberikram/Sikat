import React from 'react'
import { Trash2 } from 'lucide-react'
import { useEditorStore, VIRTUAL_CAMERA_ID } from '../store'
import { gltfLoader } from '../gltf-loader'
import { createBoxMesh, createSphereMesh, createTextTagMesh } from '../scene/primitives'
import { Button, buttonCn } from './button'
import { cn } from './cn'
import { OverlayPanel } from './overlay-panel'
import { pushToast } from './toast'

export function ObjectsOverlay() {
  const open = useEditorStore((s) => s.overlayObjects)
  const objects = useEditorStore((s) => s.objects)
  const selectedId = useEditorStore((s) => s.selectedId)
  const setSelected = useEditorStore((s) => s.setSelected)
  const removeObject = useEditorStore((s) => s.removeObject)
  const addObject = useEditorStore((s) => s.addObject)

  if (!open) return null

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const url = URL.createObjectURL(file)
    gltfLoader.load(
      url,
      (gltf) => {
        URL.revokeObjectURL(url)
        addObject({
          name: file.name.toUpperCase(),
          type: 'group',
          mesh: gltf.scene,
          scale: [2, 2, 2],
        })
      },
      undefined,
      (error) => {
        URL.revokeObjectURL(url)
        console.error('Failed to load model:', error)
        pushToast(`couldn't load ${file.name} — is it a valid .glb/.gltf?`)
      }
    )
  }

  return (
    <OverlayPanel overlayKey="objects" title="OBJECTS" className="overlay-objects">
      <div className="flex flex-wrap gap-1.5 mb-3">
        <label className={buttonCn('primary', 'sm', 'cursor-pointer')}>
          IMPORT
          <input type="file" accept=".gltf,.glb" onChange={handleImport} className="hidden" />
        </label>
        <Button
          size="sm"
          onClick={() => addObject({ name: 'BOX_MDL_01', type: 'mesh', mesh: createBoxMesh() })}
        >
          BOX
        </Button>
        <Button
          size="sm"
          onClick={() => addObject({ name: 'SPHERE_MDL_02', type: 'mesh', mesh: createSphereMesh() })}
        >
          SPHERE
        </Button>
        <Button
          size="sm"
          onClick={() => addObject({ name: 'TAG_PLANE_00', type: 'mesh', mesh: createTextTagMesh() })}
        >
          TAG
        </Button>
      </div>

      <div className="flex flex-col gap-2 overflow-y-auto flex-1 min-h-0">
        <div
          onClick={() => setSelected(VIRTUAL_CAMERA_ID)}
          className={cn('layer-item group', selectedId === VIRTUAL_CAMERA_ID && 'active')}
        >
          <span className="opacity-50 text-[10px] font-mono">00.</span>
          <span className="truncate flex-1 font-mono">VIRTUAL_CAMERA</span>
        </div>
        {objects.map((obj, i) => (
          <div
            key={obj.id}
            onClick={() => setSelected(obj.id)}
            className={cn('layer-item group', selectedId === obj.id && 'active')}
          >
            <span className="opacity-50 text-[10px] font-mono">{String(i + 1).padStart(2, '0')}.</span>
            <span className="truncate flex-1">{obj.name}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                removeObject(obj.id)
              }}
              className="opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </OverlayPanel>
  )
}
