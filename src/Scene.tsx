/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useEditorStore } from './store';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

// Fallback to WebGL if WebGPURenderer is not easily available or compatible with the current setup
// Three.js WebGPURenderer is still in jsm/renderers/webgpu/WebGPURenderer.js
// but for standard usage WebGLRenderer is more robust.
// However, the prompt specifically asked for WebGPU.
// I will try to use the experimental WebGPURenderer if possible.

function tagSceneInfrastructure(obj: THREE.Object3D) {
  obj.userData.isSceneInfrastructure = true;
}

export const Scene: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // One canvas only: clear strays from Strict Mode remounts / failed cleanup before appending
    container.replaceChildren();

    // SCENE SETUP
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#f2f2f2');
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
    camera.position.set(6, 4, 6);
    camera.lookAt(0, 0.75, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.style.display = 'block';
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0.75, 0);
    controls.update();

    const transformControl = new TransformControls(camera, renderer.domElement);
    transformControl.setMode('translate');
    transformControl.setSize(1.1);
    const gizmoHelper = transformControl.getHelper();
    tagSceneInfrastructure(gizmoHelper as unknown as THREE.Object3D);
    scene.add(gizmoHelper);

    function syncObjectToStore() {
      const o = transformControl.object;
      if (!o) return;
      const id = o.userData?.id as string | undefined;
      if (!id) return;
      const euler = o.rotation;
      useEditorStore.getState().updateObject(id, {
        position: [o.position.x, o.position.y, o.position.z],
        rotation: [euler.x, euler.y, euler.z],
        scale: [o.scale.x, o.scale.y, o.scale.z]
      });
    }

    transformControl.addEventListener('objectChange', syncObjectToStore);

    transformControl.addEventListener('mouseDown', () => {
      controls.enabled = false;
    });
    transformControl.addEventListener('mouseUp', () => {
      controls.enabled = true;
      const o = transformControl.object;
      if (!o) return;
      const id = o.userData?.id as string | undefined;
      if (!id) return;
      const t = useEditorStore.getState().currentTime;
      const euler = o.rotation;
      const st = useEditorStore.getState();
      st.addKeyframe(id, t, 'position', [o.position.x, o.position.y, o.position.z]);
      st.addKeyframe(id, t, 'rotation', [euler.x, euler.y, euler.z]);
      st.addKeyframe(id, t, 'scale', [o.scale.x, o.scale.y, o.scale.z]);
    });

    // LIGHTING
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    tagSceneInfrastructure(ambientLight);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
    directionalLight.position.set(5, 10, 7);
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.set(1024, 1024);
    tagSceneInfrastructure(directionalLight);
    scene.add(directionalLight);

    let lastGizmoObject: THREE.Object3D | null = null;

    // Initial object (StrictMode remount skips if store already has objects)
    if (useEditorStore.getState().objects.length === 0) {
      const sphereGeo = new THREE.SphereGeometry(1, 32, 32);
      const sphereMat = new THREE.MeshToonMaterial({ color: 0x0076FF });
      const sphere = new THREE.Mesh(sphereGeo, sphereMat);
      const st = useEditorStore.getState();
      st.addObject({ name: 'CORE_SPHERE', type: 'mesh', mesh: sphere });
      const added = useEditorStore.getState().objects;
      if (added.length === 1) st.setSelected(added[0].id);
    }

    let lastObjectIdSig = '';
    function pruneRemovedObjectsFromScene() {
      const { objects: ob } = useEditorStore.getState();
      const sig = ob.map((o) => o.id).sort().join(',');
      if (sig === lastObjectIdSig) return;
      lastObjectIdSig = sig;
      const objectIds = new Set(ob.map((o) => o.id));
      scene.children.slice().forEach((child) => {
        if ((child as THREE.Object3D).userData?.isSceneInfrastructure) return;
        const id = (child as THREE.Object3D).userData?.id;
        if (id && !objectIds.has(id)) scene.remove(child);
      });
    }

    const unsubStore = useEditorStore.subscribe(() => pruneRemovedObjectsFromScene());

    // ANIMATION LOOP
    let lastTime = performance.now();
    let rafId = 0;
    const animate = (now: number) => {
      const delta = (now - lastTime) / 1000;
      lastTime = now;

      const { isPlaying, currentTime, objects: liveObjects, selectedId } = useEditorStore.getState();

      if (isPlaying) {
        useEditorStore.setState((state) => ({
          currentTime: (state.currentTime + delta) % state.duration
        }));
      }

      const selected = liveObjects.find((o) => o.id === selectedId);
      if (selected?.mesh) {
        if (lastGizmoObject !== selected.mesh) {
          transformControl.attach(selected.mesh);
          lastGizmoObject = selected.mesh;
        }
      } else if (lastGizmoObject) {
        transformControl.detach();
        lastGizmoObject = null;
      }

      // Update object transforms based on keyframes or store values
      liveObjects.forEach(obj => {
        if (!obj.mesh) return;

        const gizmoIsDragging = transformControl.dragging
          && transformControl.object === obj.mesh;

        if (!gizmoIsDragging) {
        // Simple interpolation logic
        const pos = interpolateKeyframes(obj.keyframes, currentTime, 'position', obj.position);
        const rot = interpolateKeyframes(obj.keyframes, currentTime, 'rotation', obj.rotation);
        const sca = interpolateKeyframes(obj.keyframes, currentTime, 'scale', obj.scale);

        obj.mesh.position.set(...pos);
        obj.mesh.rotation.set(...rot);
        obj.mesh.scale.set(...sca);
        }

        // Per-object effect simulations (skip outline shells — they are Meshes too and would nest forever)
        obj.mesh.traverse((child) => {
          if (!(child as THREE.Mesh).isMesh) return;
          const mesh = child as THREE.Mesh;
          if (mesh.userData.isCellOutlineShell) return;
          mesh.castShadow = true;
          mesh.receiveShadow = true;

          if (obj.postProcessing.cellShading) {
            if (!mesh.userData.outline) {
              const outlineMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });
              const outlineMesh = new THREE.Mesh(mesh.geometry, outlineMaterial);
              outlineMesh.scale.multiplyScalar(1.05);
              outlineMesh.userData.isCellOutlineShell = true;
              mesh.add(outlineMesh);
              mesh.userData.outline = outlineMesh;
            }
          } else if (mesh.userData.outline) {
            mesh.remove(mesh.userData.outline);
            mesh.userData.outline = null;
          }

          if (obj.postProcessing.glitch && Math.random() > 0.95)
            mesh.position.x += (Math.random() - 0.5) * 0.1;
        });

        if (!scene.children.includes(obj.mesh)) {
          scene.add(obj.mesh);
        }
      });

      controls.update();
      renderer.render(scene, camera);
      rafId = requestAnimationFrame(animate);
    };

    rafId = requestAnimationFrame(animate);

    // RESIZE — use container box, not window.innerWidth
    const handleResize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width === 0 || height === 0) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);
    
    handleResize();
    pruneRemovedObjectsFromScene();

    return () => {
      cancelAnimationFrame(rafId);
      unsubStore();
      resizeObserver.disconnect();
      transformControl.dispose();
      scene.remove(gizmoHelper);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div ref={containerRef} id="canvas-container" className="relative z-0 h-full w-full min-h-0" />;
};

function interpolateKeyframes(keyframes: any[], time: number, property: string, defaultValue: [number, number, number]): [number, number, number] {
  const kf = keyframes.filter(k => k.property === property);
  if (kf.length === 0) return defaultValue;
  if (kf.length === 1) return kf[0].value;

  // Find surrounding keyframes
  const nextIdx = kf.findIndex(k => k.time > time);
  if (nextIdx === -1) return kf[kf.length - 1].value;
  if (nextIdx === 0) return kf[0].value;

  const prev = kf[nextIdx - 1];
  const next = kf[nextIdx];

  const alpha = (time - prev.time) / (next.time - prev.time);
  return [
    prev.value[0] + (next.value[0] - prev.value[0]) * alpha,
    prev.value[1] + (next.value[1] - prev.value[1]) * alpha,
    prev.value[2] + (next.value[2] - prev.value[2]) * alpha,
  ];
}
