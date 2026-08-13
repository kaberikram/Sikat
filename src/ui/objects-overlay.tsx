import React from 'react'
import { Trash2 } from 'lucide-react'
import { useEditorStore, VIRTUAL_CAMERA_ID } from '../store'
import { gltfLoader } from '../gltf-loader'
import { createBoxMesh, createSphereMesh, createTextTagMesh } from '../scene/primitives'
import { Button, buttonCn } from './button'
import { cn } from './cn'
import { OverlayPanel } from './overlay-panel'
import { pushToast } from './toast'

function displayName(name: string): string {
  return name.toLowerCase()
}

export function ObjectsOverlay() {
  const open = useEditorStore((s) => s.overlayObjects)
  const objects = useEditorStore((s) => s.objects)
  const selectedId = useEditorStore((s) => s.selectedId)
  const setSelected = useEditorStore((s) => s.setSelected)
  const removeObject = useEditorStore((s) => s.removeObject)
  const addObject = useEditorStore((s) => s.addObject)

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
          primitive: 'gltf',
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
    <OverlayPanel overlayKey="objects" title="objects" className="overlay-objects" open={open}>
      <div className="flex flex-wrap gap-[7px]">
        <label className={buttonCn('primary', 'sm', 'cursor-pointer')}>
          import
          <input type="file" accept=".gltf,.glb" onChange={handleImport} className="hidden" />
        </label>
        <Button
          variant="wash"
          size="sm"
          onClick={() => addObject({ name: 'BOX_MDL_01', type: 'mesh', primitive: 'box', mesh: createBoxMesh() })}
        >
          box
        </Button>
        <Button
          variant="wash"
          size="sm"
          onClick={() => addObject({ name: 'SPHERE_MDL_02', type: 'mesh', primitive: 'sphere', mesh: createSphereMesh() })}
        >
          sphere
        </Button>
        <Button
          variant="wash"
          size="sm"
          onClick={() => addObject({ name: 'TAG_PLANE_00', type: 'mesh', primitive: 'text', mesh: createTextTagMesh() })}
        >
          tag
        </Button>
      </div>

      <div className="flex flex-col gap-[6px] overflow-y-auto flex-1 min-h-0">
        <div
          onClick={() => setSelected(VIRTUAL_CAMERA_ID)}
          className={cn('layer-item group', selectedId === VIRTUAL_CAMERA_ID && 'active')}
        >
          <span className="text-[10px] font-mono text-faint">00.</span>
          <span className="truncate flex-1">{displayName('virtual_camera')}</span>
          <span
            className={cn(
              'status-dot',
              selectedId === VIRTUAL_CAMERA_ID ? 'status-dot--accent' : ''
            )}
          />
        </div>
        {objects.map((obj, i) => (
          <div
            key={obj.id}
            onClick={() => setSelected(obj.id)}
            className={cn('layer-item group', selectedId === obj.id && 'active')}
          >
            <span className="text-[10px] font-mono text-faint">{String(i + 1).padStart(2, '0')}.</span>
            <span className="truncate flex-1">{displayName(obj.name)}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                removeObject(obj.id)
              }}
              className="opacity-0 group-hover:opacity-100 transition-opacity text-ink-soft"
            >
              <Trash2 size={12} />
            </button>
            <span className={cn('status-dot', selectedId === obj.id ? 'status-dot--accent' : '')} />
          </div>
        ))}
      </div>
    </OverlayPanel>
  )
}
