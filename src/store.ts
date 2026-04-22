import { create } from 'zustand';
import * as THREE from 'three';

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
  if (!partial) return d;
  return {
    bloom: { ...d.bloom, ...partial.bloom },
    pixelate: { ...d.pixelate, ...partial.pixelate },
    cellShading: { ...d.cellShading, ...partial.cellShading },
    glitch: { ...d.glitch, ...partial.glitch },
    dither: { ...d.dither, ...partial.dither },
  };
}

export interface MotionObject {
  id: string;
  name: string;
  type: 'mesh' | 'group';
  mesh?: THREE.Object3D;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  postProcessing: PostProcessingStack;
  keyframes: Array<{
    time: number;
    property: 'position' | 'rotation' | 'scale';
    value: [number, number, number];
  }>;
}

interface EditorState {
  objects: MotionObject[];
  selectedId: string | null;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  addObject: (obj: Partial<MotionObject>) => void;
  removeObject: (id: string) => void;
  updateObject: (id: string, updates: Partial<MotionObject>) => void;
  setSelected: (id: string | null) => void;
  setTime: (time: number) => void;
  togglePlay: () => void;
  addKeyframe: (objectId: string, time: number, property: 'position' | 'rotation' | 'scale', value: [number, number, number]) => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  objects: [],
  selectedId: null,
  currentTime: 0,
  duration: 10,
  isPlaying: false,
  addObject: (obj) => set((state) => {
    const id = Math.random().toString(36).substr(2, 9);
    const motion: MotionObject = {
      id,
      name: obj.name || 'Untitled Object',
      type: obj.type || 'mesh',
      mesh: obj.mesh,
      position: obj.position || [0, 0, 0],
      rotation: obj.rotation || [0, 0, 0],
      scale: obj.scale || [1, 1, 1],
      postProcessing: mergePostProcessing(obj.postProcessing),
      keyframes: obj.keyframes || [],
    };
    // Scene cleanup matches scene children by mesh.userData.id — must equal MotionObject.id
    if (motion.mesh)
      motion.mesh.userData = { ...motion.mesh.userData, id };
    return { objects: [...state.objects, motion] };
  }),
  removeObject: (id) => set((state) => ({
    objects: state.objects.filter(o => o.id !== id),
    selectedId: state.selectedId === id ? null : state.selectedId
  })),
  updateObject: (id, updates) => set((state) => ({
    objects: state.objects.map(o => o.id === id ? { ...o, ...updates } : o)
  })),
  setSelected: (id) => set({ selectedId: id }),
  setTime: (time) => set({ currentTime: time }),
  togglePlay: () => set((state) => ({ isPlaying: !state.isPlaying })),
  addKeyframe: (objectId, time, property, value) => set((state) => ({
    objects: state.objects.map(obj => {
      if (obj.id !== objectId) return obj;
      const otherKeyframes = obj.keyframes.filter(k => !(k.time === time && k.property === property));
      return {
        ...obj,
        keyframes: [...otherKeyframes, { time, property, value }].sort((a, b) => a.time - b.time)
      };
    })
  }))
}));
