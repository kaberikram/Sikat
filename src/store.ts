import { create } from 'zustand';
import * as THREE from 'three';

export interface MotionObject {
  id: string;
  name: string;
  type: 'mesh' | 'group';
  mesh?: THREE.Object3D;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  postProcessing: {
    bloom: boolean;
    pixelate: boolean;
    cellShading: boolean;
    glitch: boolean;
  };
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
  addObject: (obj) => set((state) => ({
    objects: [...state.objects, {
      id: Math.random().toString(36).substr(2, 9),
      name: obj.name || 'Untitled Object',
      type: obj.type || 'mesh',
      mesh: obj.mesh,
      position: obj.position || [0, 0, 0],
      rotation: obj.rotation || [0, 0, 0],
      scale: obj.scale || [1, 1, 1],
      postProcessing: obj.postProcessing || {
        bloom: false,
        pixelate: false,
        cellShading: true,
        glitch: false,
      },
      keyframes: obj.keyframes || [],
    }]
  })),
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
