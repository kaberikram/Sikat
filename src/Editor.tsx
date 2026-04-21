import React from 'react';
import { useEditorStore } from './store';
import { Play, Pause, ChevronRight, Square, Box, Plus, Trash2, Layers, Sliders, BoxSelect } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Scene } from './Scene';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const Toolbar: React.FC = () => {
  const addObject = useEditorStore(state => state.addObject);

  const addBox = () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshToonMaterial({ color: '#FF6B00' });
    const mesh = new THREE.Mesh(geometry, material);
    (mesh as any).userData = { id: Math.random().toString(36).substr(2, 9) };
    addObject({ name: 'BOX_MDL_01', type: 'mesh', mesh });
  };

  const addSphere = () => {
    const geometry = new THREE.SphereGeometry(0.5, 32, 32);
    const material = new THREE.MeshToonMaterial({ color: '#0094FF' });
    const mesh = new THREE.Mesh(geometry, material);
    (mesh as any).userData = { id: Math.random().toString(36).substr(2, 9) };
    addObject({ name: 'SPHERE_MDL_02', type: 'mesh', mesh });
  };

  const addText = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#FF6B00';
      ctx.font = 'bold 80px "Arial Black"';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 12;
      ctx.strokeText('JET!', 256, 128);
      ctx.fillText('JET!', 256, 128);
    }
    
    const texture = new THREE.CanvasTexture(canvas);
    const geometry = new THREE.PlaneGeometry(2, 1);
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    (mesh as any).userData = { id: Math.random().toString(36).substr(2, 9) };
    addObject({ name: 'TAG_PLANE_00', type: 'mesh', mesh });
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const url = URL.createObjectURL(file);
    const loader = new GLTFLoader();
    loader.load(url, (gltf) => {
      const model = gltf.scene;
      (model as any).userData = { id: Math.random().toString(36).substr(2, 9) };
      addObject({ 
        name: file.name.toUpperCase(), 
        type: 'group', 
        mesh: model,
        scale: [2, 2, 2]
      });
    });
  };

  return (
    <div className="flex gap-2">
      <label className="nav-btn brutalist-shadow flex items-center justify-center cursor-pointer">
        IMPORT_OBJ
        <input type="file" accept=".gltf,.glb" onChange={handleImport} className="hidden" />
      </label>
      <button onClick={addBox} className="nav-btn brutalist-shadow">ADD_BOX</button>
      <button onClick={addSphere} className="nav-btn brutalist-shadow">ADD_SPHERE</button>
      <button onClick={addText} className="nav-btn brutalist-shadow">ADD_TAG</button>
    </div>
  );
};

export const Timeline: React.FC = () => {
  const { currentTime, duration, setTime, isPlaying, togglePlay, objects } = useEditorStore();

  return (
    <footer className="timeline-panel" style={{ gridArea: 'timeline' }}>
      <div className="timeline-controls">
        <div className="flex gap-4 items-center">
          <button 
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
        {objects.map(obj => (
          <div key={obj.id} className="track relative group">
            <span className="text-[9px] w-24 px-4 bg-black text-white mr-4 truncate flex items-center h-full">
              {obj.name}
            </span>
            <div className="flex-1 h-full relative cursor-pointer" onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const x = e.clientX - rect.left;
              setTime((x / rect.width) * duration);
            }}>
              {obj.keyframes.map((kf, idx) => (
                <div 
                  key={idx}
                  className="keyframe absolute top-1/2 -translate-y-1/2"
                  style={{ left: `${(kf.time / duration) * 100}%` }}
                />
              ))}
              {/* Playhead line visualization could go here */}
            </div>
            {/* Scrubber overlay */}
            <input 
              type="range" 
              min={0} 
              max={duration} 
              step={0.01}
              value={currentTime}
              onChange={(e) => setTime(parseFloat(e.target.value))}
              className="absolute inset-0 opacity-0 cursor-pointer w-full z-10"
            />
          </div>
        ))}
      </div>
    </footer>
  );
};

export const Outliner: React.FC = () => {
  const { objects, selectedId, setSelected, removeObject } = useEditorStore();

  return (
    <aside className="layers-panel" style={{ gridArea: 'layers' }}>
      <span className="panel-title">OBJECTS</span>
      <div className="flex flex-col gap-2 overflow-y-auto pr-1">
        {objects.map((obj, i) => (
          <div 
            key={obj.id} 
            onClick={() => setSelected(obj.id)}
            className={cn(
              "layer-item group",
              selectedId === obj.id && "active"
            )}
          >
            <span className="opacity-50 text-[9px]">{String(i + 1).padStart(2, '0')}.</span>
            <span className="truncate flex-1">{obj.name}</span>
            <button 
              onClick={(e) => { e.stopPropagation(); removeObject(obj.id); }}
              className="opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-auto">
        <div className="bg-black text-white p-2 text-[10px] transform rotate-1 flex justify-between">
          <span>MEMORY_FREE</span>
          <span>88%</span>
        </div>
      </div>
    </aside>
  );
};

export const Properties: React.FC = () => {
  const { objects, selectedId, updateObject, addKeyframe, currentTime } = useEditorStore();
  const selected = objects.find(o => o.id === selectedId);

  return (
    <aside className="props-panel" style={{ gridArea: 'props' }}>
      <span className="panel-title">POST_STACK</span>
      
      {!selected ? (
        <div className="text-[10px] opacity-40 italic text-center mt-10">SELECT AN OBJECT</div>
      ) : (
        <div className="flex flex-col gap-2 mt-4">
          <div className="bg-black/10 p-2 border-2 border-black mb-2">
            <div className="text-[9px] opacity-50 mb-1">SELECTED</div>
            <div className="text-xs font-bold truncate">{selected.name}</div>
          </div>

          <div className="fx-row">
            <span className="text-[11px] block mb-2">TRANSFORM</span>
            <div className="grid grid-cols-3 gap-1">
              {[0, 1, 2].map(i => (
                <input 
                  key={i}
                  type="number" 
                  value={selected.position[i]} 
                  onChange={(e) => {
                    const newPos = [...selected.position] as [number, number, number];
                    newPos[i] = parseFloat(e.target.value);
                    updateObject(selected.id, { position: newPos });
                  }}
                  className="w-full bg-white border-2 border-black p-1 text-[9px] font-bold"
                />
              ))}
            </div>
            <button 
              onClick={() => addKeyframe(selected.id, currentTime, 'position', selected.position)}
              className="w-full mt-2 bg-black text-white text-[9px] py-1 font-bold hover:bg-jsr-orange"
            >
              ADD_KEYFRAME
            </button>
          </div>

          {Object.entries(selected.postProcessing).map(([key, val]) => (
            <div key={key} className="fx-row flex items-center justify-between group cursor-pointer" 
                 onClick={() => updateObject(selected.id, { postProcessing: { ...selected.postProcessing, [key]: !val } })}>
              <span className="text-[11px]">{key.toUpperCase()}</span>
              <div className={cn("fx-toggle transition-colors", val && "bg-black")} />
            </div>
          ))}
        </div>
      )}
    </aside>
  );
};

// Main App Layout
export const Editor: React.FC = () => {
  const objects = useEditorStore(state => state.objects);

  const handleExport = () => {
    const data = objects.map(o => ({
      name: o.name,
      position: o.position,
      rotation: o.rotation,
      scale: o.scale,
      keyframes: o.keyframes,
      postProcessing: o.postProcessing
    }));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'radio_edit_export.json';
    a.click();
  };

  return (
    <div className="app-grid bg-[var(--bg-color)]">
      <header className="header select-none">
        <div className="flex items-center gap-4">
          <div className="w-[30px] h-[30px] bg-white rounded-full border-2 border-black flex items-center justify-center relative">
            <div className="absolute inset-[4px] border-2 border-jsr-orange rounded-full border-t-transparent animate-spin" />
          </div>
          <h1 className="logo font-bold uppercase tracking-tighter italic">
            RADIO_EDIT.EXE
          </h1>
        </div>
        <div className="flex gap-2">
          <Toolbar />
          <button 
            onClick={handleExport}
            className="nav-btn brutalist-shadow" 
            style={{ background: 'var(--jsr-pink)', color: 'white' }}
          >
            EXPORT_JSON
          </button>
        </div>
      </header>

      <Outliner />

      <main className="viewport relative overflow-hidden viewport-bg">
        <div className="absolute top-10 left-10 p-4 border-4 border-black bg-white brutalist-shadow z-10 select-none">
          <div className="text-[10px] text-gray-500 font-bold uppercase">VIEWPORT_MODE</div>
          <div className="text-xl uppercase font-black tracking-tighter italic">Shaded_Final</div>
        </div>
        
        {/* The Scene component is siblings with absolute overlay */}
        <div className="absolute inset-0">
          <Scene />
        </div>

        <div className="absolute bottom-10 right-10 w-20 h-20 rounded-full border-2 border-black bg-white/80 z-10 flex items-center justify-center italic font-bold">
          XYZ
        </div>
      </main>

      <Properties />
      <Timeline />
    </div>
  );
};
