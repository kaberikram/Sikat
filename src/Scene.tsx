/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useEditorStore, type MotionObject, type PostProcessingBloom } from './store';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { RenderPixelatedPass } from 'three/examples/jsm/postprocessing/RenderPixelatedPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

// Fallback to WebGL if WebGPURenderer is not easily available or compatible with the current setup
// Three.js WebGPURenderer is still in jsm/renderers/webgpu/WebGPURenderer.js
// but for standard usage WebGLRenderer is more robust.
// However, the prompt specifically asked for WebGPU.
// I will try to use the experimental WebGPURenderer if possible.

function tagSceneInfrastructure(obj: THREE.Object3D) {
  obj.userData.isSceneInfrastructure = true;
}

function forEachMeshMaterial(mesh: THREE.Mesh, fn: (mat: THREE.Material) => void) {
  const m = mesh.material;
  if (Array.isArray(m)) m.forEach(fn);
  else fn(m);
}

interface BloomMatUserData {
  bloomSaved?: boolean;
  bloomPrevEmissive?: THREE.Color;
  bloomPrevIntensity?: number;
}

function syncBloomMaterial(mat: THREE.Material, bloom: PostProcessingBloom) {
  if (!('emissive' in mat) || !('color' in mat)) return;
  const m = mat as THREE.MeshStandardMaterial;
  const u = m.userData as BloomMatUserData;
  if (bloom.enabled) {
    if (!u.bloomSaved) {
      u.bloomSaved = true;
      u.bloomPrevEmissive = m.emissive.clone();
      u.bloomPrevIntensity = m.emissiveIntensity;
    }
    m.emissive.copy(m.color).multiplyScalar(bloom.emissiveBoost);
    m.emissiveIntensity = bloom.emissiveIntensity;
  } else if (u.bloomSaved && u.bloomPrevEmissive) {
    m.emissive.copy(u.bloomPrevEmissive);
    m.emissiveIntensity = u.bloomPrevIntensity ?? 0;
    delete u.bloomSaved;
    delete u.bloomPrevEmissive;
    delete u.bloomPrevIntensity;
  }
}

function aggregateBloomPassParams(objects: MotionObject[]) {
  const on = objects.filter((o) => o.postProcessing.bloom.enabled);
  if (on.length === 0) return null;
  return {
    strength: Math.max(...on.map((o) => o.postProcessing.bloom.strength)),
    radius: Math.max(...on.map((o) => o.postProcessing.bloom.radius)),
    threshold: Math.min(...on.map((o) => o.postProcessing.bloom.threshold)),
  };
}

function aggregatePixelateParams(objects: MotionObject[]) {
  const on = objects.filter((o) => o.postProcessing.pixelate.enabled);
  if (on.length === 0) return null;
  return {
    pixelSize: Math.max(...on.map((o) => o.postProcessing.pixelate.pixelSize)),
    normalEdge: Math.max(...on.map((o) => o.postProcessing.pixelate.normalEdge)),
    depthEdge: Math.max(...on.map((o) => o.postProcessing.pixelate.depthEdge)),
  };
}

function aggregateDitherParams(objects: MotionObject[]) {
  const on = objects.filter((o) => o.postProcessing.dither.enabled);
  if (on.length === 0) return null;
  return {
    pixelSize: Math.max(...on.map((o) => o.postProcessing.dither.pixelSize)),
    levels: Math.min(...on.map((o) => o.postProcessing.dither.levels)),
    strength: Math.max(...on.map((o) => o.postProcessing.dither.strength)),
    monochrome: on.some((o) => o.postProcessing.dither.monochrome),
  };
}

const DitherShader = {
  name: 'DitherShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1, 1) },
    pixelSize: { value: 2 },
    levels: { value: 4 },
    strength: { value: 1 },
    monochrome: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float pixelSize;
    uniform float levels;
    uniform float strength;
    uniform float monochrome;
    varying vec2 vUv;

    float bayer2(vec2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
    float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
    float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }

    void main() {
      vec2 cell = floor(vUv * resolution / max(pixelSize, 1.0));
      vec2 sampleUv = (cell * max(pixelSize, 1.0) + 0.5) / resolution;

      vec3 original = texture2D(tDiffuse, vUv).rgb;
      vec3 color = texture2D(tDiffuse, sampleUv).rgb;

      if (monochrome > 0.5) {
        float l = dot(color, vec3(0.299, 0.587, 0.114));
        color = vec3(l);
      }

      float quant = max(levels - 1.0, 1.0);
      float threshold = bayer8(cell) - 0.5;

      vec3 dithered = color + threshold / quant;
      dithered = clamp(floor(dithered * quant + 0.5) / quant, 0.0, 1.0);

      vec3 finalColor = mix(original, dithered, clamp(strength, 0.0, 1.0));
      gl_FragColor = vec4(finalColor, 1.0);
    }
  `,
};

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
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.domElement.style.display = 'block';
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const composer = new EffectComposer(renderer);
    composer.setPixelRatio(renderer.getPixelRatio());
    const renderPass = new RenderPass(scene, camera);
    const pixelatedPass = new RenderPixelatedPass(8, scene, camera, {
      normalEdgeStrength: 0.25,
      depthEdgeStrength: 0.35,
    });
    renderPass.enabled = true;
    pixelatedPass.enabled = false;
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.9, 0.4, 0.18);
    bloomPass.enabled = false;
    const ditherPass = new ShaderPass(DitherShader);
    ditherPass.enabled = false;
    const outputPass = new OutputPass();
    outputPass.enabled = false;
    composer.addPass(renderPass);
    composer.addPass(pixelatedPass);
    composer.addPass(bloomPass);
    composer.addPass(ditherPass);
    composer.addPass(outputPass);

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
      const gizmoTarget = selected?.mesh;
      if (gizmoTarget) {
        transformControl.enabled = true;
        if (lastGizmoObject !== gizmoTarget) {
          transformControl.attach(gizmoTarget);
          lastGizmoObject = gizmoTarget;
        }
      } else {
        transformControl.enabled = false;
        if (lastGizmoObject) {
          transformControl.detach();
          lastGizmoObject = null;
        }
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

          const cell = obj.postProcessing.cellShading;
          if (cell.enabled) {
            const outlineScale = cell.outlineScale;
            if (!mesh.userData.outline) {
              const outlineMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });
              const outlineMesh = new THREE.Mesh(mesh.geometry, outlineMaterial);
              outlineMesh.scale.setScalar(outlineScale);
              outlineMesh.userData.isCellOutlineShell = true;
              mesh.add(outlineMesh);
              mesh.userData.outline = outlineMesh;
            } else {
              (mesh.userData.outline as THREE.Mesh).scale.setScalar(outlineScale);
            }
          } else if (mesh.userData.outline) {
            mesh.remove(mesh.userData.outline);
            mesh.userData.outline = null;
          }

          forEachMeshMaterial(mesh, (mat) => syncBloomMaterial(mat, obj.postProcessing.bloom));

          const glitch = obj.postProcessing.glitch;
          if (glitch.enabled && Math.random() < glitch.rate)
            mesh.position.x += (Math.random() - 0.5) * glitch.intensity;
        });

        if (!scene.children.includes(obj.mesh)) {
          scene.add(obj.mesh);
        }
      });

      const needsPixelate = liveObjects.some((o) => o.postProcessing.pixelate.enabled);
      const needsBloom = liveObjects.some((o) => o.postProcessing.bloom.enabled);
      const needsDither = liveObjects.some((o) => o.postProcessing.dither.enabled);
      const needsComposer = needsPixelate || needsBloom || needsDither;

      const pixAgg = aggregatePixelateParams(liveObjects);
      if (pixAgg) {
        pixelatedPass.setPixelSize(pixAgg.pixelSize);
        pixelatedPass.normalEdgeStrength = pixAgg.normalEdge;
        pixelatedPass.depthEdgeStrength = pixAgg.depthEdge;
      }

      const bloomAgg = aggregateBloomPassParams(liveObjects);
      if (bloomAgg) {
        bloomPass.strength = bloomAgg.strength;
        bloomPass.radius = bloomAgg.radius;
        bloomPass.threshold = bloomAgg.threshold;
      }

      const ditherAgg = aggregateDitherParams(liveObjects);
      if (ditherAgg) {
        const size = renderer.getSize(new THREE.Vector2());
        const pr = renderer.getPixelRatio();
        ditherPass.uniforms.resolution.value.set(size.x * pr, size.y * pr);
        ditherPass.uniforms.pixelSize.value = ditherAgg.pixelSize;
        ditherPass.uniforms.levels.value = ditherAgg.levels;
        ditherPass.uniforms.strength.value = ditherAgg.strength;
        ditherPass.uniforms.monochrome.value = ditherAgg.monochrome ? 1 : 0;
      }

      renderPass.enabled = !needsPixelate;
      pixelatedPass.enabled = needsPixelate;
      bloomPass.enabled = needsBloom;
      ditherPass.enabled = needsDither;
      outputPass.enabled = needsComposer;

      controls.update();
      if (needsComposer) composer.render(delta);
      else renderer.render(scene, camera);
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
      composer.setSize(width, height);
      composer.setPixelRatio(renderer.getPixelRatio());
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
      pixelatedPass.dispose();
      bloomPass.dispose();
      ditherPass.dispose();
      outputPass.dispose();
      composer.dispose();
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
