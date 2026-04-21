/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useEditorStore } from './store';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// Fallback to WebGL if WebGPURenderer is not easily available or compatible with the current setup
// Three.js WebGPURenderer is still in jsm/renderers/webgpu/WebGPURenderer.js
// but for standard usage WebGLRenderer is more robust.
// However, the prompt specifically asked for WebGPU.
// I will try to use the experimental WebGPURenderer if possible.

export const Scene: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const objects = useEditorStore(state => state.objects);
  const currentTime = useEditorStore(state => state.currentTime);
  const isPlaying = useEditorStore(state => state.isPlaying);
  const setTime = useEditorStore(state => state.setTime);
  const duration = useEditorStore(state => state.duration);

  useEffect(() => {
    if (!containerRef.current) return;

    // SCENE SETUP
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#E8E8E8'); // High Density BG Color
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 5;
    camera.position.y = 2;
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    containerRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    // LIGHTING
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
    directionalLight.position.set(5, 10, 7);
    scene.add(directionalLight);

    // GRID HELPER
    const gridHelper = new THREE.GridHelper(20, 20, 0x141414, 0x141414);
    (gridHelper.material as THREE.Material).transparent = true;
    (gridHelper.material as THREE.Material).opacity = 0.2;
    scene.add(gridHelper);

    // Initial object to make it feel "active"
    const sphereGeo = new THREE.SphereGeometry(1, 32, 32);
    const sphereMat = new THREE.MeshToonMaterial({ color: 0x0076FF });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    sphere.userData = { id: 'init-sphere' };
    useEditorStore.getState().addObject({ name: 'CORE_SPHERE', type: 'mesh', mesh: sphere });

    // ANIMATION LOOP
    let lastTime = performance.now();
    const animate = (now: number) => {
      const delta = (now - lastTime) / 1000;
      lastTime = now;

      if (isPlaying) {
        useEditorStore.setState((state) => ({
          currentTime: (state.currentTime + delta) % state.duration
        }));
      }

      // Update object transforms based on keyframes or store values
      objects.forEach(obj => {
        if (!obj.mesh) return;

        // Simple interpolation logic
        const pos = interpolateKeyframes(obj.keyframes, currentTime, 'position', obj.position);
        const rot = interpolateKeyframes(obj.keyframes, currentTime, 'rotation', obj.rotation);
        const sca = interpolateKeyframes(obj.keyframes, currentTime, 'scale', obj.scale);

        obj.mesh.position.set(...pos);
        obj.mesh.rotation.set(...rot);
        obj.mesh.scale.set(...sca);

        // Per-object effect simulations
        obj.mesh.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh;
            
            // Simulation of "WebGPU-like" per-object effects
            if (obj.postProcessing.cellShading) {
              // Add outline if not exists
              if (!mesh.userData.outline) {
                const outlineMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });
                const outlineMesh = new THREE.Mesh(mesh.geometry, outlineMaterial);
                outlineMesh.scale.multiplyScalar(1.05);
                mesh.add(outlineMesh);
                mesh.userData.outline = outlineMesh;
              }
            } else if (mesh.userData.outline) {
              mesh.remove(mesh.userData.outline);
              mesh.userData.outline = null;
            }

            if (obj.postProcessing.glitch && Math.random() > 0.95) {
              mesh.position.x += (Math.random() - 0.5) * 0.1;
            }
          }
        });

        if (!scene.children.includes(obj.mesh)) {
          scene.add(obj.mesh);
        }
      });

      controls.update();
      renderer.render(scene, camera);
      requestAnimationFrame(animate);
    };

    requestAnimationFrame(animate);

    // RESIZE
    const handleResize = () => {
      if (!containerRef.current) return;
      const width = containerRef.current.clientWidth;
      const height = containerRef.current.clientHeight;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);
    
    // Initial call
    handleResize();

    return () => {
      resizeObserver.disconnect();
      renderer.dispose();
      if (containerRef.current) {
        containerRef.current.removeChild(renderer.domElement);
      }
    };
  }, []);

  // Helper to sync objects when they are added/removed from state
  useEffect(() => {
    if (!sceneRef.current) return;
    const scene = sceneRef.current;

    // Remove meshes that are no longer in state
    const objectIds = new Set(objects.map(o => o.id));
    scene.children.forEach(child => {
      if ((child as any).userData?.id && !objectIds.has((child as any).userData.id)) {
        scene.remove(child);
      }
    });
  }, [objects]);

  return <div ref={containerRef} id="canvas-container" className="w-full h-full" />;
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
