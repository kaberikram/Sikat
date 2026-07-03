import React, { useState, useMemo } from 'react'
import { useEditorStore, VIRTUAL_CAMERA_ID, type MotionObject, type PostProcessingStack, type VirtualCamera } from './store'
import { Trash2, ChevronDown, ChevronRight, Check } from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import * as THREE from 'three'
import { gltfLoader } from './gltf-loader'
import { Scene } from './Scene'
import { exportMp4 } from './exporter'
import { buildTurnaroundRotationKeyframes } from './animation-presets'
import { DirectorConsole } from './director/DirectorConsole'

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

type PostSectionId = keyof PostProcessingStack

const POST_STACK_SECTIONS: {
  id: PostSectionId
  label: string
  sliders: { key: string; label: string; min: number; max: number; step: number }[]
  toggles?: { key: string; label: string }[]
}[] = [
  {
    id: 'bloom',
    label: 'BLOOM',
    sliders: [
      { key: 'strength', label: 'Strength', min: 0, max: 2.5, step: 0.05 },
      { key: 'threshold', label: 'Threshold', min: 0, max: 1, step: 0.01 },
      { key: 'radius', label: 'Radius', min: 0, max: 1, step: 0.02 },
      { key: 'emissiveBoost', label: 'Surface glow', min: 0, max: 1.5, step: 0.05 },
      { key: 'emissiveIntensity', label: 'Glow intensity', min: 0, max: 3, step: 0.05 },
    ],
  },
  {
    id: 'pixelate',
    label: 'PIXELATE',
    sliders: [
      { key: 'pixelSize', label: 'Block size', min: 2, max: 24, step: 1 },
      { key: 'normalEdge', label: 'Normal edge', min: 0, max: 0.8, step: 0.05 },
      { key: 'depthEdge', label: 'Depth edge', min: 0, max: 0.8, step: 0.05 },
    ],
  },
  {
    id: 'cellShading',
    label: 'CELL_SHADING',
    sliders: [{ key: 'outlineScale', label: 'Outline inflate', min: 1, max: 1.18, step: 0.005 }],
  },
  {
    id: 'glitch',
    label: 'GLITCH',
    sliders: [
      { key: 'intensity', label: 'Jitter amount', min: 0, max: 0.5, step: 0.01 },
      { key: 'rate', label: 'Jitter rate', min: 0, max: 0.35, step: 0.01 },
    ],
  },
  {
    id: 'dither',
    label: 'DITHER',
    sliders: [
      { key: 'pixelSize', label: 'Dot size', min: 1, max: 10, step: 1 },
      { key: 'levels', label: 'Color levels', min: 2, max: 16, step: 1 },
      { key: 'strength', label: 'Mix', min: 0, max: 1, step: 0.05 },
    ],
    toggles: [{ key: 'monochrome', label: 'Monochrome' }],
  },
]

function patchCameraPostSection<S extends PostSectionId>(
  vc: VirtualCamera,
  section: S,
  patch: Partial<PostProcessingStack[S]>
): { postProcessing: PostProcessingStack } {
  return {
    postProcessing: {
      ...vc.postProcessing,
      [section]: { ...vc.postProcessing[section], ...patch },
    },
  }
}

function PostFxCheckbox({ checked }: { checked: boolean }) {
  return (
    <span
      className={cn('fx-toggle pointer-events-none', checked && 'fx-toggle--on')}
      aria-hidden
    >
      {checked ? (
        <Check size={13} strokeWidth={3} className="text-[var(--jsr-yellow)]" />
      ) : null}
    </span>
  )
}

export const Toolbar: React.FC = () => {
  const addObject = useEditorStore((state) => state.addObject)

  const addBox = () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1)
    const material = new THREE.MeshToonMaterial({ color: '#FF6B00' })
    const mesh = new THREE.Mesh(geometry, material)
    addObject({ name: 'BOX_MDL_01', type: 'mesh', mesh })
  }

  const addSphere = () => {
    const geometry = new THREE.SphereGeometry(0.5, 32, 32)
    const material = new THREE.MeshToonMaterial({ color: '#0094FF' })
    const mesh = new THREE.Mesh(geometry, material)
    addObject({ name: 'SPHERE_MDL_02', type: 'mesh', mesh })
  }

  const addText = () => {
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 256
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.fillStyle = '#FF6B00'
      ctx.font = 'bold 80px "Arial Black"'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.strokeStyle = 'black'
      ctx.lineWidth = 12
      ctx.strokeText('JET!', 256, 128)
      ctx.fillText('JET!', 256, 128)
    }
    const texture = new THREE.CanvasTexture(canvas)
    const geometry = new THREE.PlaneGeometry(2, 1)
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide })
    const mesh = new THREE.Mesh(geometry, material)
    addObject({ name: 'TAG_PLANE_00', type: 'mesh', mesh })
  }

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const url = URL.createObjectURL(file)
    gltfLoader.load(
      url,
      (gltf) => {
        URL.revokeObjectURL(url)
        const model = gltf.scene
        addObject({
          name: file.name.toUpperCase(),
          type: 'group',
          mesh: model,
          scale: [2, 2, 2],
        })
      },
      undefined,
      (error) => {
        URL.revokeObjectURL(url)
        console.error('Failed to load model:', error)
      }
    )
  }

  return (
    <div className="flex gap-2">
      <label className="nav-btn brutalist-shadow flex items-center justify-center cursor-pointer">
        IMPORT_OBJ
        <input type="file" accept=".gltf,.glb" onChange={handleImport} className="hidden" />
      </label>
      <button type="button" onClick={addBox} className="nav-btn brutalist-shadow">ADD_BOX</button>
      <button type="button" onClick={addSphere} className="nav-btn brutalist-shadow">ADD_SPHERE</button>
      <button type="button" onClick={addText} className="nav-btn brutalist-shadow">ADD_TAG</button>
    </div>
  )
}

function TimelineTrackRow({
  name,
  keyframes,
  duration,
  currentTime,
  onSeek,
  showScrub,
}: {
  name: string
  keyframes: { time: number }[]
  duration: number
  currentTime: number
  onSeek: (t: number) => void
  showScrub: boolean
}) {
  return (
    <div className="track relative group min-h-8">
      <span className="text-[9px] w-24 px-4 bg-black text-white mr-4 truncate flex items-center h-full min-h-8">
        {name}
      </span>
      <div
        className="flex-1 h-full min-h-8 relative cursor-pointer"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const x = e.clientX - rect.left
          onSeek((x / rect.width) * duration)
        }}
      >
        {keyframes.map((kf, idx) => (
          <div
            key={idx}
            className="keyframe absolute top-1/2 -translate-y-1/2"
            style={{ left: `${(kf.time / duration) * 100}%` }}
          />
        ))}
        {showScrub ? (
          <input
            type="range"
            min={0}
            max={duration}
            step={0.01}
            value={currentTime}
            onChange={(e) => onSeek(parseFloat(e.target.value))}
            className="absolute inset-0 opacity-0 cursor-pointer w-full z-10"
          />
        ) : null}
      </div>
    </div>
  )
}

export const Timeline: React.FC = () => {
  const { currentTime, duration, setTime, isPlaying, togglePlay, objects, virtualCamera } = useEditorStore()
  return (
    <footer className="timeline-panel" style={{ gridArea: 'timeline' }}>
      <div className="timeline-controls">
        <div className="flex gap-4 items-center">
          <button
            type="button"
            onClick={togglePlay}
            className="bg-black text-white px-4 py-1 text-xs hover:bg-jsr-orange transition-colors"
          >
            {isPlaying ? 'PAUSE' : 'PLAY'}
          </button>
          <span className="text-xs font-mono font-bold">{currentTime.toFixed(2)}s</span>
          <span className="opacity-50 text-[10px]">FPS: 60.0</span>
        </div>
      </div>

      <div className="timeline-tracks flex-grow overflow-y-auto">
        <TimelineTrackRow
          name="VIRTUAL_CAMERA"
          keyframes={virtualCamera.keyframes}
          duration={duration}
          currentTime={currentTime}
          onSeek={setTime}
          showScrub
        />
        {objects.map((obj) => (
          <React.Fragment key={obj.id}>
            <TimelineTrackRow
              name={obj.name}
              keyframes={obj.keyframes}
              duration={duration}
              currentTime={currentTime}
              onSeek={setTime}
              showScrub
            />
          </React.Fragment>
        ))}
      </div>
    </footer>
  )
}

export const Outliner: React.FC = () => {
  const { objects, selectedId, setSelected, removeObject } = useEditorStore()
  return (
    <aside
      className="layers-panel"
      style={{ gridArea: 'layers' }}
      onClick={() => setSelected(null)}
    >
      <span className="panel-title select-none">OBJECTS</span>
      <div className="flex flex-col gap-2 overflow-y-auto pr-1 flex-1 min-h-0">
        <div
          onClick={(e) => {
            e.stopPropagation()
            setSelected(VIRTUAL_CAMERA_ID)
          }}
          className={cn('layer-item group', selectedId === VIRTUAL_CAMERA_ID && 'active')}
        >
          <span className="opacity-50 text-[9px]">00.</span>
          <span className="truncate flex-1 font-mono">VIRTUAL_CAMERA</span>
        </div>
        {objects.map((obj, i) => (
          <div
            key={obj.id}
            onClick={(e) => {
              e.stopPropagation()
              setSelected(obj.id)
            }}
            className={cn('layer-item group', selectedId === obj.id && 'active')}
          >
            <span className="opacity-50 text-[9px]">{String(i + 1).padStart(2, '0')}.</span>
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
      <div className="mt-auto shrink-0" onClick={(e) => e.stopPropagation()}>
        <div className="bg-black text-white p-2 text-[10px] transform rotate-1 flex justify-between">
          <span>MEMORY_FREE</span>
          <span>88%</span>
        </div>
      </div>
    </aside>
  )
}

function PostStackEditor({
  openSections,
  setOpenSections,
  selected,
  patchSection,
  updateSectionSlider,
  updateSectionToggle,
}: {
  openSections: Partial<Record<PostSectionId, boolean>>
  setOpenSections: React.Dispatch<React.SetStateAction<Partial<Record<PostSectionId, boolean>>>>
  selected: VirtualCamera
  patchSection: <S extends PostSectionId>(section: S, patch: Partial<PostProcessingStack[S]>) => void
  updateSectionSlider: (section: PostSectionId, key: string, v: number) => void
  updateSectionToggle: (section: PostSectionId, key: string) => void
}) {
  return (
    <>
      {POST_STACK_SECTIONS.map((section) => {
        const cfg = selected.postProcessing[section.id]
        const expanded = !!openSections[section.id]
        const numericCfg = cfg as unknown as Record<string, number | boolean>
        return (
          <div key={section.id} className="fx-row">
            <div className="flex items-center gap-1 justify-between">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpenSections((s) => ({ ...s, [section.id]: !s[section.id] }))}
                className="p-0.5 border-2 border-black bg-white hover:bg-black/5 shrink-0"
              >
                {expanded ? <ChevronDown size={14} strokeWidth={2.5} /> : <ChevronRight size={14} strokeWidth={2.5} />}
              </button>
              <span className="text-[11px] font-bold flex-1 truncate">{section.label}</span>
              <button
                type="button"
                aria-pressed={cfg.enabled}
                onClick={() => patchSection(section.id, { enabled: !cfg.enabled })}
                className="shrink-0 cursor-pointer border-0 bg-transparent p-0"
              >
                <PostFxCheckbox checked={cfg.enabled} />
              </button>
            </div>
            <AnimatePresence initial={false}>
              {expanded ? (
                <motion.div
                  key={`fx-${section.id}`}
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="overflow-hidden"
                >
                  <div className="mt-2 pt-2 border-t-2 border-black/15 space-y-3">
                    {section.sliders.map((sl) => {
                      const value = numericCfg[sl.key] as number
                      return (
                        <label key={sl.key} className="block">
                          <div className="flex justify-between text-[9px] font-mono font-bold mb-0.5">
                            <span>{sl.label}</span>
                            <span className="opacity-60">{value.toFixed(sl.step < 1 ? 2 : 0)}</span>
                          </div>
                          <input
                            type="range"
                            min={sl.min}
                            max={sl.max}
                            step={sl.step}
                            value={value}
                            onChange={(e) => updateSectionSlider(section.id, sl.key, parseFloat(e.target.value))}
                            className="w-full accent-black h-2"
                          />
                        </label>
                      )
                    })}
                    {section.toggles?.map((tg) => {
                      const on = numericCfg[tg.key] as boolean
                      return (
                        <button
                          key={tg.key}
                          type="button"
                          onClick={() => updateSectionToggle(section.id, tg.key)}
                          className="flex w-full items-center justify-between gap-2 cursor-pointer border-0 bg-transparent p-0 text-left"
                        >
                          <span className="text-[9px] font-mono font-bold">{tg.label}</span>
                          <PostFxCheckbox checked={on} />
                        </button>
                      )
                    })}
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        )
      })}
    </>
  )
}

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

export const Properties: React.FC = () => {
  const { objects, selectedId, updateObject, addKeyframe, addCameraKeyframe, currentTime, virtualCamera, updateCamera, duration, setObjectPropertyKeyframes, setTime, setSubMeshTransparent, setSubMeshShadow } =
    useEditorStore()
  const [openSections, setOpenSections] = useState<Partial<Record<PostSectionId, boolean>>>({})
  const selected = objects.find((o) => o.id === selectedId)
  const cameraMode = selectedId === VIRTUAL_CAMERA_ID

  const subMeshes = useMemo(
    () => (selected?.mesh ? collectDescendantMeshes(selected.mesh) : []),
    [selected?.mesh, selected?.id]
  )

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

  function commitCameraVector(
    property: 'position' | 'rotation',
    value: [number, number, number]
  ) {
    updateCamera({ [property]: value })
    if (virtualCamera.keyframes.some((k) => k.property === property))
      addCameraKeyframe(currentTime, property, value)
  }

  function commitCameraFov(value: number) {
    updateCamera({ fov: value })
    if (virtualCamera.keyframes.some((k) => k.property === 'fov'))
      addCameraKeyframe(currentTime, 'fov', [value, 0, 0])
  }

  if (!selectedId) {
    return (
      <aside className="props-panel" style={{ gridArea: 'props' }}>
        <span className="panel-title">PROPERTIES</span>
        <div className="text-[10px] opacity-40 italic text-center mt-10">SELECT AN OBJECT OR CAMERA</div>
      </aside>
    )
  }

  if (cameraMode) {
    return (
      <aside className="props-panel" style={{ gridArea: 'props' }}>
        <span className="panel-title">VIEWFINDER / LENS</span>
        <div className="flex flex-col gap-2 mt-4 overflow-y-auto max-h-[calc(100vh-12rem)] pr-1">
          <div className="bg-black/10 p-2 border-2 border-black mb-2 shrink-0">
            <div className="text-[9px] opacity-50 mb-1">SELECTED</div>
            <div className="text-xs font-bold truncate">{virtualCamera.name}</div>
          </div>
          <div className="fx-row shrink-0">
            <span className="text-[11px] block mb-2">CAMERA</span>
            <div className="text-[9px] opacity-60 mb-1">POSITION</div>
            <div className="grid grid-cols-3 gap-1 mb-2">
              {[0, 1, 2].map((i) => (
                <input
                  key={i}
                  type="number"
                  value={virtualCamera.position[i]}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value)
                    if (Number.isNaN(v)) return
                    const newPos = [...virtualCamera.position] as [number, number, number]
                    newPos[i] = v
                    commitCameraVector('position', newPos)
                  }}
                  className="w-full bg-white border-2 border-black p-1 text-[9px] font-bold"
                />
              ))}
            </div>
            <div className="text-[9px] opacity-60 mb-1">ROTATION</div>
            <div className="grid grid-cols-3 gap-1 mb-2">
              {[0, 1, 2].map((i) => (
                <input
                  key={i}
                  type="number"
                  value={virtualCamera.rotation[i]}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value)
                    if (Number.isNaN(v)) return
                    const r = [...virtualCamera.rotation] as [number, number, number]
                    r[i] = v
                    commitCameraVector('rotation', r)
                  }}
                  className="w-full bg-white border-2 border-black p-1 text-[9px] font-bold"
                />
              ))}
            </div>
            <label className="text-[9px] opacity-60 block mb-1">FOV</label>
            <input
              type="number"
              value={virtualCamera.fov}
              onChange={(e) => {
                const v = parseFloat(e.target.value)
                if (Number.isNaN(v)) return
                commitCameraFov(v)
              }}
              className="w-full bg-white border-2 border-black p-1 text-[9px] font-bold"
            />
            <button
              type="button"
              onClick={() => {
                const v = useEditorStore.getState().virtualCamera
                addCameraKeyframe(currentTime, 'position', v.position)
                addCameraKeyframe(currentTime, 'rotation', v.rotation)
                addCameraKeyframe(currentTime, 'fov', [v.fov, 0, 0])
              }}
              className="w-full mt-2 bg-black text-white text-[9px] py-1 font-bold hover:bg-jsr-orange"
            >
              ADD_KEYFRAME
            </button>
          </div>
          <span className="text-[10px] font-mono font-bold">POST_STACK</span>
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
      </aside>
    )
  }

  if (!selected) {
    return (
      <aside className="props-panel" style={{ gridArea: 'props' }}>
        <span className="panel-title">PROPERTIES</span>
        <div className="text-[10px] opacity-40 italic text-center mt-10">SELECT AN OBJECT</div>
      </aside>
    )
  }

  return (
    <aside className="props-panel" style={{ gridArea: 'props' }}>
      <span className="panel-title">TRANSFORM</span>
      <div className="flex flex-col gap-2 mt-4 overflow-y-auto max-h-[calc(100vh-12rem)] pr-1">
        <div className="bg-black/10 p-2 border-2 border-black mb-2 shrink-0">
          <div className="text-[9px] opacity-50 mb-1">SELECTED</div>
          <div className="text-xs font-bold truncate">{selected.name}</div>
        </div>
        <div className="fx-row shrink-0">
          <span className="text-[11px] block mb-2">POSITION</span>
          <div className="grid grid-cols-3 gap-1">
            {[0, 1, 2].map((i) => (
              <input
                key={i}
                type="number"
                value={selected.position[i]}
                onChange={(e) => {
                  const v = parseFloat(e.target.value)
                  if (Number.isNaN(v)) return
                  const newPos = [...selected.position] as [number, number, number]
                  newPos[i] = v
                  commitObjectVector(selected, 'position', newPos)
                }}
                className="w-full bg-white border-2 border-black p-1 text-[9px] font-bold"
              />
            ))}
          </div>
        </div>
        <div className="fx-row shrink-0">
          <span className="text-[11px] block mb-2">ROTATION</span>
          <div className="grid grid-cols-3 gap-1">
            {[0, 1, 2].map((i) => (
              <input
                key={i}
                type="number"
                value={selected.rotation[i]}
                onChange={(e) => {
                  const v = parseFloat(e.target.value)
                  if (Number.isNaN(v)) return
                  const r = [...selected.rotation] as [number, number, number]
                  r[i] = v
                  commitObjectVector(selected, 'rotation', r)
                }}
                className="w-full bg-white border-2 border-black p-1 text-[9px] font-bold"
              />
            ))}
          </div>
        </div>
        <div className="fx-row shrink-0">
          <span className="text-[11px] block mb-2">SCALE</span>
          <div className="grid grid-cols-3 gap-1">
            {[0, 1, 2].map((i) => (
              <input
                key={i}
                type="number"
                value={selected.scale[i]}
                onChange={(e) => {
                  const v = parseFloat(e.target.value)
                  if (Number.isNaN(v)) return
                  const s = [...selected.scale] as [number, number, number]
                  s[i] = v
                  commitObjectVector(selected, 'scale', s)
                }}
                className="w-full bg-white border-2 border-black p-1 text-[9px] font-bold"
              />
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            const o = useEditorStore.getState().objects.find((x) => x.id === selected.id)
            if (!o) return
            const t = useEditorStore.getState().currentTime
            addKeyframe(o.id, t, 'position', o.position)
            addKeyframe(o.id, t, 'rotation', o.rotation)
            addKeyframe(o.id, t, 'scale', o.scale)
          }}
          className="w-full mt-1 bg-black text-white text-[9px] py-1 font-bold hover:bg-jsr-orange"
        >
          ADD_KEYFRAME
        </button>
        <button
          type="button"
          onClick={() => {
            const kfs = buildTurnaroundRotationKeyframes(selected.rotation, duration)
            setObjectPropertyKeyframes(selected.id, 'rotation', kfs)
            setTime(0)
          }}
          title="Auto-rotate 360° on Y axis across the full timeline"
          className="w-full mt-1 bg-[var(--jsr-pink)] text-white text-[9px] py-1 font-bold hover:bg-black"
        >
          360_TURNAROUND
        </button>
        {subMeshes.length > 0 && (
          <div className="fx-row shrink-0 border-t-2 border-black/20 pt-2 mt-2">
            <div className="text-[11px] block mb-2">
              MESHES
              <div className="text-[8px] font-mono font-bold opacity-60 mt-0.5 flex justify-end gap-3">
                <span>α</span>
                <span>SHD</span>
              </div>
            </div>
            <ul className="flex flex-col gap-1.5 max-h-40 overflow-y-auto pr-0.5">
              {subMeshes.map((m, i) => (
                <li key={m.uuid} className="grid grid-cols-[1fr_auto_auto] items-center gap-2 min-h-[22px]">
                  <span className="text-[9px] font-mono font-bold truncate min-w-0" title={m.name || `Mesh ${i + 1}`}>
                    {m.name || `MESH_${i + 1}`}
                  </span>
                  <label className="flex items-center justify-center text-[8px] cursor-pointer" title="Transparent">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 border-2 border-black accent-black"
                      checked={getEffectiveMeshTransparent(m, selected.subMeshTransparent)}
                      onChange={(e) => {
                        setSubMeshTransparent(selected.id, m.uuid, e.target.checked)
                      }}
                    />
                  </label>
                  <label className="flex items-center justify-center text-[8px] cursor-pointer" title="Cast and receive shadows">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 border-2 border-black accent-black"
                      checked={getEffectiveMeshShadow(m, selected.subMeshShadow)}
                      onChange={(e) => {
                        setSubMeshShadow(selected.id, m.uuid, e.target.checked)
                      }}
                    />
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </aside>
  )
}

function ExportMp4Modal({
  open,
  onClose,
  defaultDuration,
}: {
  open: boolean
  onClose: () => void
  defaultDuration: number
}) {
  const [w, setW] = useState(1920)
  const [h, setH] = useState(1080)
  const [fps, setFps] = useState(60)
  const [dur, setDur] = useState(defaultDuration)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white border-4 border-black brutalist-shadow max-w-md w-full p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-black uppercase tracking-tight mb-3">Export MP4</h2>
        <div className="grid grid-cols-2 gap-2 text-[10px]">
          <label className="col-span-1">
            <span className="block font-bold mb-0.5">Width</span>
            <input
              type="number"
              value={w}
              onChange={(e) => setW(parseInt(e.target.value, 10) || 1)}
              className="w-full border-2 border-black p-1"
            />
          </label>
          <label>
            <span className="block font-bold mb-0.5">Height</span>
            <input
              type="number"
              value={h}
              onChange={(e) => setH(parseInt(e.target.value, 10) || 1)}
              className="w-full border-2 border-black p-1"
            />
          </label>
          <label>
            <span className="block font-bold mb-0.5">FPS</span>
            <input
              type="number"
              value={fps}
              onChange={(e) => setFps(parseInt(e.target.value, 10) || 1)}
              className="w-full border-2 border-black p-1"
            />
          </label>
          <label>
            <span className="block font-bold mb-0.5">Duration (s)</span>
            <input
              type="number"
              value={dur}
              onChange={(e) => setDur(parseFloat(e.target.value) || 0.1)}
              className="w-full border-2 border-black p-1"
            />
          </label>
        </div>
        {error ? <p className="text-red-600 text-[10px] mt-2">{error}</p> : null}
        <div className="mt-3 h-3 border-2 border-black bg-black/10">
          <div
            className="h-full bg-jsr-orange transition-[width] duration-150"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
        <div className="mt-3 flex gap-2 justify-end">
          <button type="button" className="nav-btn" onClick={onClose} disabled={running}>
            CANCEL
          </button>
          <button
            type="button"
            className="nav-btn"
            style={{ background: 'var(--jsr-pink)', color: 'white' }}
            disabled={running}
            onClick={async () => {
              setError(null)
              setRunning(true)
              setProgress(0)
              try {
                const blob = await exportMp4({
                  width: w,
                  height: h,
                  fps,
                  duration: dur,
                  onProgress: setProgress,
                })
                const a = document.createElement('a')
                a.href = URL.createObjectURL(blob)
                a.download = `radio_edit_${Date.now()}.mp4`
                a.click()
                URL.revokeObjectURL(a.href)
                onClose()
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Export failed')
              } finally {
                setRunning(false)
              }
            }}
          >
            {running ? 'ENCODING...' : 'START'}
          </button>
        </div>
      </div>
    </div>
  )
}

export const Editor: React.FC = () => {
  const objects = useEditorStore((s) => s.objects)
  const virtualCamera = useEditorStore((s) => s.virtualCamera)
  const duration = useEditorStore((s) => s.duration)
  const [pipMountEl, setPipMountEl] = useState<HTMLDivElement | null>(null)
  const [exportOpen, setExportOpen] = useState(false)

  const handleExportJson = () => {
    const data = {
      virtualCamera: {
        position: virtualCamera.position,
        rotation: virtualCamera.rotation,
        fov: virtualCamera.fov,
        keyframes: virtualCamera.keyframes,
        postProcessing: virtualCamera.postProcessing,
      },
      objects: objects.map((o) => ({
        name: o.name,
        position: o.position,
        rotation: o.rotation,
        scale: o.scale,
        keyframes: o.keyframes,
      })),
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'radio_edit_export.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="app-grid bg-[var(--bg-color)]">
      <header className="header select-none">
        <div className="flex items-center gap-4">
          <div className="w-[30px] h-[30px] bg-white rounded-full border-2 border-black flex items-center justify-center relative">
            <div className="absolute inset-[4px] border-2 border-jsr-orange rounded-full border-t-transparent animate-spin" />
          </div>
          <h1 className="logo font-bold uppercase tracking-tighter italic">RADIO_EDIT.EXE</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Toolbar />
          <button
            type="button"
            onClick={handleExportJson}
            className="nav-btn brutalist-shadow"
            style={{ background: 'var(--jsr-pink)', color: 'white' }}
          >
            EXPORT_JSON
          </button>
          <button
            type="button"
            onClick={() => setExportOpen(true)}
            className="nav-btn brutalist-shadow"
            style={{ background: 'var(--jsr-pink)', color: 'white' }}
          >
            EXPORT_MP4
          </button>
        </div>
      </header>

      <Outliner />

      <main className="viewport relative overflow-hidden viewport-bg">
        <div className="absolute inset-0">
          <Scene pipMountEl={pipMountEl} />
        </div>

        <div
          className="z-20 border-4 border-black bg-black brutalist-shadow relative"
          style={{
            position: 'absolute',
            right: '16px',
            bottom: '16px',
            width: '320px',
            height: '180px',
            maxWidth: '42vw',
            maxHeight: '35vh',
          }}
        >
          <div className="absolute top-0 left-0 z-10 p-1 bg-white border-b-2 border-r-2 border-black text-[8px] font-mono">
            VIRTUAL_CAM
          </div>
          <div ref={setPipMountEl} className="absolute inset-0" />
        </div>

        <DirectorConsole />
      </main>

      <Properties />
      <Timeline />
      <ExportMp4Modal open={exportOpen} onClose={() => setExportOpen(false)} defaultDuration={duration} />
    </div>
  )
}
