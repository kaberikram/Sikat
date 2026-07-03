import { create } from 'zustand';
import * as THREE from 'three';

export const VIRTUAL_CAMERA_ID = 'virtualCamera' as const;
export type VirtualCameraId = typeof VIRTUAL_CAMERA_ID;

export interface PostProcessingBloom {
  enabled: boolean;
  strength: number;
  threshold: number;
  radius: number;
  emissiveBoost: number;
  emissiveIntensity: number;
}

export interface PostProcessingPixelate {
  enabled: boolean;
  pixelSize: number;
  normalEdge: number;
  depthEdge: number;
}

export interface PostProcessingCellShading {
  enabled: boolean;
  outlineScale: number;
}

export interface PostProcessingGlitch {
  enabled: boolean;
  intensity: number;
  rate: number;
}

export interface PostProcessingDither {
  enabled: boolean;
  pixelSize: number;
  levels: number;
  strength: number;
  monochrome: boolean;
}

export interface PostProcessingStack {
  bloom: PostProcessingBloom;
  pixelate: PostProcessingPixelate;
  cellShading: PostProcessingCellShading;
  glitch: PostProcessingGlitch;
  dither: PostProcessingDither;
}

export function createDefaultPostProcessing(): PostProcessingStack {
  return {
    bloom: {
      enabled: false,
      strength: 0.9,
      threshold: 0.18,
      radius: 0.4,
      emissiveBoost: 0.55,
      emissiveIntensity: 1.35,
    },
    pixelate: {
      enabled: false,
      pixelSize: 8,
      normalEdge: 0.25,
      depthEdge: 0.35,
    },
    cellShading: {
      enabled: true,
      outlineScale: 1.05,
    },
    glitch: {
      enabled: false,
      intensity: 0.1,
      rate: 0.06,
    },
    dither: {
      enabled: false,
      pixelSize: 2,
      levels: 4,
      strength: 1,
      monochrome: false,
    },
  };
}

function mergePostProcessing(partial?: Partial<PostProcessingStack>): PostProcessingStack {
  const d = createDefaultPostProcessing();
  if (!partial) return d
  return {
    bloom: { ...d.bloom, ...partial.bloom },
    pixelate: { ...d.pixelate, ...partial.pixelate },
    cellShading: { ...d.cellShading, ...partial.cellShading },
    glitch: { ...d.glitch, ...partial.glitch },
    dither: { ...d.dither, ...partial.dither },
  };
}

export interface SceneLighting {
  ambient: { color: string; intensity: number };
  key: { color: string; intensity: number; position: [number, number, number] };
  background: string;
}

/** Defaults match the values previously hard-coded in Scene.tsx. */
export function createDefaultLighting(): SceneLighting {
  return {
    ambient: { color: '#ffffff', intensity: 0.8 },
    key: { color: '#ffffff', intensity: 1.5, position: [5, 10, 7] },
    background: '#f2f2f2',
  };
}

export interface LightingPatch {
  ambient?: Partial<SceneLighting['ambient']>;
  key?: Partial<SceneLighting['key']>;
  background?: string;
}

export interface MaterialOverride {
  color?: string;
  emissive?: string;
  emissiveIntensity?: number;
  opacity?: number;
}

export type CameraKeyframeProperty = 'position' | 'rotation' | 'fov';

export interface VirtualCamera {
  id: typeof VIRTUAL_CAMERA_ID;
  name: 'VIRTUAL_CAMERA';
  position: [number, number, number];
  rotation: [number, number, number];
  fov: number;
  postProcessing: PostProcessingStack;
  keyframes: Array<{
    time: number
    property: CameraKeyframeProperty
    value: [number, number, number]
  }>;
}

/** World-space euler XYZ. Identity = camera on +Z side of scene looking toward -Z (Three.js default view axis). */
const DEFAULT_VIRTUAL_CAM_ROTATION: [number, number, number] = [0, 0, 0]

export function createDefaultVirtualCamera(): VirtualCamera {
  return {
    id: VIRTUAL_CAMERA_ID,
    name: 'VIRTUAL_CAMERA',
    position: [0, 1.25, 6],
    rotation: [...DEFAULT_VIRTUAL_CAM_ROTATION],
    fov: 50,
    postProcessing: mergePostProcessing(),
    keyframes: [],
  }
}

export interface MotionObject {
  id: string;
  name: string;
  type: 'mesh' | 'group';
  mesh?: THREE.Object3D;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  keyframes: Array<{
    time: number
    property: 'position' | 'rotation' | 'scale'
    value: [number, number, number]
  }>;
  /** Per-mesh (`THREE.Mesh.uuid`) transparent override for imported / composite objects. */
  subMeshTransparent?: Record<string, boolean>
  /** Per-mesh shadow: `false` = no cast / receive. Omitted or `true` = scene default (on). */
  subMeshShadow?: Record<string, boolean>
  /** Material changes applied by Director Mode agents (kept for scene export). */
  materialOverride?: MaterialOverride
}

interface EditorState {
  objects: MotionObject[];
  virtualCamera: VirtualCamera;
  lighting: SceneLighting;
  selectedId: string | null;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  /** When true, Scene skips its RAF loop so export can own the same Three.js scene. */
  isExporting: boolean
  setExporting: (v: boolean) => void
  addObject: (obj: Partial<MotionObject>) => void
  removeObject: (id: string) => void
  updateObject: (id: string, updates: Partial<MotionObject>) => void
  setSubMeshTransparent: (objectId: string, meshUuid: string, transparent: boolean) => void
  setSubMeshShadow: (objectId: string, meshUuid: string, castAndReceive: boolean) => void
  updateLighting: (patch: LightingPatch) => void
  setObjectMaterial: (id: string, patch: MaterialOverride) => void
  updateCamera: (updates: Partial<VirtualCamera>) => void
  setSelected: (id: string | null) => void
  setTime: (time: number) => void
  togglePlay: () => void
  addKeyframe: (
    objectId: string,
    time: number,
    property: 'position' | 'rotation' | 'scale',
    value: [number, number, number]
  ) => void
  addCameraKeyframe: (
    time: number,
    property: CameraKeyframeProperty,
    value: [number, number, number]
  ) => void
  /** Replaces all keyframes of a single property on an object. Used by preset animations like turnaround. */
  setObjectPropertyKeyframes: (
    objectId: string,
    property: 'position' | 'rotation' | 'scale',
    keyframes: Array<{ time: number; value: [number, number, number] }>
  ) => void
}

export const useEditorStore = create<EditorState>((set) => ({
  objects: [],
  virtualCamera: createDefaultVirtualCamera(),
  lighting: createDefaultLighting(),
  selectedId: null,
  currentTime: 0,
  duration: 10,
  isPlaying: false,
  isExporting: false,
  setExporting: (v) => set({ isExporting: v }),
  addObject: (obj) => set((state) => {
    const id = obj.id ?? Math.random().toString(36).substr(2, 9);
    const motion: MotionObject = {
      id,
      name: obj.name || 'Untitled Object',
      type: obj.type || 'mesh',
      mesh: obj.mesh,
      position: obj.position || [0, 0, 0],
      rotation: obj.rotation || [0, 0, 0],
      scale: obj.scale || [1, 1, 1],
      keyframes: obj.keyframes || [],
    }
    if (motion.mesh)
      motion.mesh.userData = { ...motion.mesh.userData, id }
    return { objects: [...state.objects, motion] }
  }),
  removeObject: (id) => set((state) => ({
    objects: state.objects.filter(o => o.id !== id),
    selectedId: state.selectedId === id ? null : state.selectedId,
  })),
  updateObject: (id, updates) => set((state) => ({
    objects: state.objects.map(o => o.id === id ? { ...o, ...updates } : o),
  })),
  setSubMeshTransparent: (objectId, meshUuid, transparent) => set((state) => {
    const obj = state.objects.find((o) => o.id === objectId)
    if (!obj?.mesh) return state
    let target: THREE.Mesh | null = null
    obj.mesh.traverse((c) => {
      if (c instanceof THREE.Mesh && c.uuid === meshUuid) target = c
    })
    if (!target) return state
    const materials = Array.isArray(target.material) ? target.material : [target.material]
    for (const m of materials) m.transparent = transparent
    return {
      objects: state.objects.map((o) => {
        if (o.id !== objectId) return o
        return {
          ...o,
          subMeshTransparent: { ...o.subMeshTransparent, [meshUuid]: transparent },
        }
      }),
    }
  }),
  setSubMeshShadow: (objectId, meshUuid, castAndReceive) => set((state) => {
    const obj = state.objects.find((o) => o.id === objectId)
    if (!obj?.mesh) return state
    let target: THREE.Mesh | null = null
    obj.mesh.traverse((c) => {
      if (c instanceof THREE.Mesh && c.uuid === meshUuid) target = c
    })
    if (!target) return state
    target.castShadow = castAndReceive
    target.receiveShadow = castAndReceive
    return {
      objects: state.objects.map((o) => {
        if (o.id !== objectId) return o
        const subMeshShadow = { ...o.subMeshShadow }
        if (castAndReceive) delete subMeshShadow[meshUuid]
        else subMeshShadow[meshUuid] = false
        return { ...o, subMeshShadow }
      }),
    }
  }),
  updateLighting: (patch) => set((state) => ({
    lighting: {
      ambient: { ...state.lighting.ambient, ...patch.ambient },
      key: { ...state.lighting.key, ...patch.key },
      background: patch.background ?? state.lighting.background,
    },
  })),
  setObjectMaterial: (id, patch) => set((state) => {
    const obj = state.objects.find((o) => o.id === id)
    if (!obj?.mesh) return state
    // Same mutate-THREE-inside-the-store pattern as setSubMeshTransparent.
    obj.mesh.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return
      if (child.userData.isCellOutlineShell) return
      const materials = Array.isArray(child.material) ? child.material : [child.material]
      for (const m of materials) {
        const mat = m as THREE.MeshStandardMaterial
        if (patch.color !== undefined && mat.color) mat.color.set(patch.color)
        if (patch.emissive !== undefined && 'emissive' in mat) mat.emissive.set(patch.emissive)
        if (patch.emissiveIntensity !== undefined && 'emissiveIntensity' in mat)
          mat.emissiveIntensity = patch.emissiveIntensity
        if (patch.opacity !== undefined) {
          mat.opacity = patch.opacity
          mat.transparent = patch.opacity < 1
        }
      }
    })
    return {
      objects: state.objects.map((o) =>
        o.id === id ? { ...o, materialOverride: { ...o.materialOverride, ...patch } } : o
      ),
    }
  }),
  updateCamera: (updates) => set((state) => ({
    virtualCamera: { ...state.virtualCamera, ...updates },
  })),
  setSelected: (id) => set({ selectedId: id }),
  setTime: (time) => set({ currentTime: time }),
  togglePlay: () => set((state) => ({ isPlaying: !state.isPlaying })),
  addKeyframe: (objectId, time, property, value) => set((state) => ({
    objects: state.objects.map(obj => {
      if (obj.id !== objectId) return obj
      const otherKeyframes = obj.keyframes.filter(
        k => !(k.time === time && k.property === property)
      )
      return {
        ...obj,
        keyframes: [...otherKeyframes, { time, property, value }].sort((a, b) => a.time - b.time),
      }
    }),
  })),
  setObjectPropertyKeyframes: (objectId, property, keyframes) => set((state) => ({
    objects: state.objects.map(obj => {
      if (obj.id !== objectId) return obj
      const others = obj.keyframes.filter(k => k.property !== property)
      const next = [
        ...others,
        ...keyframes.map(k => ({ time: k.time, property, value: k.value })),
      ].sort((a, b) => a.time - b.time)
      return { ...obj, keyframes: next }
    }),
  })),
  addCameraKeyframe: (time, property, value) => set((state) => {
    const vc = state.virtualCamera
    const otherKeyframes = vc.keyframes.filter(
      k => !(k.time === time && k.property === property)
    )
    return {
      virtualCamera: {
        ...vc,
        keyframes: [...otherKeyframes, { time, property, value }].sort((a, b) => a.time - b.time),
      },
    }
  }),
}))
