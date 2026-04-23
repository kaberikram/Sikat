/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Viewfinder-only FX; main viewport is clean. `Scene.tsx` is the only renderer-aware module.
 */

import React, { useLayoutEffect, useRef } from 'react'
import * as THREE from 'three'
import { useEditorStore, VIRTUAL_CAMERA_ID } from './store'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { createViewfinderComposer, renderViewfinderFrame } from './pip-composer'
import { applyObjectTransformAtTime, applyVirtualCameraAtTime } from './timeline-apply'
import { registerSceneForExport } from './scene-export-registry'
import {
  applyViewfinderMeshEffects,
  stripViewfinderObjectEffects,
} from './viewfinder-mesh-fx'

function tagSceneInfrastructure(obj: THREE.Object3D) {
  obj.userData.isSceneInfrastructure = true
}

function ensureShadowsOnObjectMeshes(
  liveObjects: { mesh?: THREE.Object3D; subMeshShadow?: Record<string, boolean> }[]
) {
  for (const obj of liveObjects) {
    if (!obj.mesh) continue
    const off = obj.subMeshShadow
    obj.mesh.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const m = child as THREE.Mesh
        if (!m.userData.isCellOutlineShell) {
          if (off?.[m.uuid] === false) {
            m.castShadow = false
            m.receiveShadow = false
          } else {
            m.castShadow = true
            m.receiveShadow = true
          }
        }
      }
    })
  }
}

export interface SceneProps {
  pipMountEl: HTMLDivElement | null
}

export const Scene: React.FC<SceneProps> = ({ pipMountEl }) => {
  const containerRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const container = containerRef.current
    const pipMount = pipMountEl
    if (!container || !pipMount) return

    container.replaceChildren()

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#f2f2f2')

    const userCamera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000)
    const defaultSceneFocus = new THREE.Vector3(1.5, 0.6, 1.5)
    userCamera.position.set(7.5, 4.25, 7.5)
    userCamera.lookAt(defaultSceneFocus)
    userCamera.layers.enable(0)
    userCamera.layers.enable(1)

    const virtCamera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 1000)
    virtCamera.layers.set(0)
    virtCamera.userData.id = VIRTUAL_CAMERA_ID
    const vc0 = useEditorStore.getState().virtualCamera
    virtCamera.position.set(...vc0.position)
    virtCamera.rotation.set(...vc0.rotation)
    virtCamera.fov = vc0.fov
    virtCamera.updateProjectionMatrix()
    scene.add(virtCamera)

    const camAxes = new THREE.AxesHelper(0.75)
    camAxes.layers.set(1)
    virtCamera.add(camAxes)

    const mainRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    mainRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    mainRenderer.shadowMap.enabled = true
    mainRenderer.shadowMap.type = THREE.PCFSoftShadowMap
    mainRenderer.toneMapping = THREE.ACESFilmicToneMapping
    mainRenderer.toneMappingExposure = 1
    mainRenderer.domElement.style.display = 'block'
    container.appendChild(mainRenderer.domElement)

    const pipRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    const pipDpr = Math.min(window.devicePixelRatio, 2)
    pipRenderer.setPixelRatio(pipDpr)
    pipRenderer.shadowMap.enabled = true
    pipRenderer.toneMapping = THREE.ACESFilmicToneMapping
    pipRenderer.toneMappingExposure = 1
    pipRenderer.domElement.style.width = '100%'
    pipRenderer.domElement.style.height = '100%'
    pipRenderer.domElement.style.display = 'block'
    pipMount.appendChild(pipRenderer.domElement)

    const viewfinder = createViewfinderComposer(scene, virtCamera, pipRenderer, pipDpr)

    const handlePipResize = () => {
      const w = pipMount.clientWidth
      const h = pipMount.clientHeight
      if (w === 0 || h === 0) return
      virtCamera.aspect = w / h
      virtCamera.updateProjectionMatrix()
      pipRenderer.setSize(w, h, false)
      viewfinder.composer.setSize(w, h)
    }

    registerSceneForExport({
      scene,
      virtualCamera: virtCamera,
      getPostProcessing: () => useEditorStore.getState().virtualCamera.postProcessing,
      viewfinder: { ...viewfinder, renderer: pipRenderer },
      remeasurePip: handlePipResize,
    })

    const controls = new OrbitControls(userCamera, mainRenderer.domElement)
    controls.enableDamping = true
    controls.target.copy(defaultSceneFocus)
    controls.update()

    const transformControl = new TransformControls(userCamera, mainRenderer.domElement)
    transformControl.setMode('translate')
    transformControl.setSize(1.1)
    transformControl.getRaycaster().layers.set(1)
    const gizmoHelper = transformControl.getHelper()
    gizmoHelper.layers.set(1)
    gizmoHelper.traverse((child) => child.layers.set(1))
    tagSceneInfrastructure(gizmoHelper as unknown as THREE.Object3D)
    scene.add(gizmoHelper)

    function syncGizmoToStore() {
      const o = transformControl.object
      if (!o) return
      const id = o.userData?.id as string | undefined
      if (!id) return
      if (id === VIRTUAL_CAMERA_ID) {
        const c = o as THREE.PerspectiveCamera
        const euler = c.rotation
        useEditorStore.getState().updateCamera({
          position: [c.position.x, c.position.y, c.position.z],
          rotation: [euler.x, euler.y, euler.z],
          fov: c.fov,
        })
        return
      }
      const euler = o.rotation
      useEditorStore.getState().updateObject(id, {
        position: [o.position.x, o.position.y, o.position.z],
        rotation: [euler.x, euler.y, euler.z],
        scale: [o.scale.x, o.scale.y, o.scale.z],
      })
    }

    transformControl.addEventListener('objectChange', syncGizmoToStore)
    transformControl.addEventListener('mouseDown', () => {
      controls.enabled = false
    })
    transformControl.addEventListener('mouseUp', () => {
      controls.enabled = true
      const o = transformControl.object
      if (!o) return
      const id = o.userData?.id as string | undefined
      if (!id) return
      const t = useEditorStore.getState().currentTime
      if (id === VIRTUAL_CAMERA_ID) {
        const c = o as THREE.PerspectiveCamera
        const st = useEditorStore.getState()
        st.addCameraKeyframe(t, 'position', [c.position.x, c.position.y, c.position.z])
        st.addCameraKeyframe(t, 'rotation', [c.rotation.x, c.rotation.y, c.rotation.z])
        st.addCameraKeyframe(t, 'fov', [c.fov, 0, 0])
        return
      }
      const st = useEditorStore.getState()
      const euler = o.rotation
      st.addKeyframe(id, t, 'position', [o.position.x, o.position.y, o.position.z])
      st.addKeyframe(id, t, 'rotation', [euler.x, euler.y, euler.z])
      st.addKeyframe(id, t, 'scale', [o.scale.x, o.scale.y, o.scale.z])
    })

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8)
    tagSceneInfrastructure(ambientLight)
    scene.add(ambientLight)
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.5)
    directionalLight.position.set(5, 10, 7)
    directionalLight.castShadow = true
    directionalLight.shadow.mapSize.set(1024, 1024)
    tagSceneInfrastructure(directionalLight)
    scene.add(directionalLight)

    if (useEditorStore.getState().objects.length === 0) {
      const sphereGeo = new THREE.SphereGeometry(1, 32, 32)
      const sphereMat = new THREE.MeshToonMaterial({ color: 0x0076ff })
      const sphere = new THREE.Mesh(sphereGeo, sphereMat)
      useEditorStore.getState().addObject({ name: 'CORE_SPHERE', type: 'mesh', mesh: sphere })
    }

    let lastObjectIdSig = ''
    function pruneRemovedObjectsFromScene() {
      const { objects: ob } = useEditorStore.getState()
      const sig = ob.map((o) => o.id).sort().join(',')
      if (sig === lastObjectIdSig) return
      lastObjectIdSig = sig
      const objectIds = new Set(ob.map((o) => o.id))
      scene.children.slice().forEach((child) => {
        if ((child as THREE.Object3D).userData?.isSceneInfrastructure) return
        const id = (child as THREE.Object3D).userData?.id
        if (id === VIRTUAL_CAMERA_ID) return
        if (id && !objectIds.has(id)) scene.remove(child)
      })
    }
    const unsubStore = useEditorStore.subscribe(() => pruneRemovedObjectsFromScene())

    let lastGizmoObject: THREE.Object3D | null = null
    let lastTime = performance.now()
    let rafId = 0

    const animate = (now: number) => {
      const delta = (now - lastTime) / 1000
      lastTime = now

      const { isPlaying } = useEditorStore.getState()
      if (isPlaying) {
        useEditorStore.setState((state) => ({
          currentTime: (state.currentTime + delta) % state.duration,
        }))
      }
      const t = useEditorStore.getState().currentTime
      const gizmo = transformControl
      if (useEditorStore.getState().isExporting) {
        rafId = requestAnimationFrame(animate)
        return
      }
      const stack = useEditorStore.getState().virtualCamera.postProcessing
      const liveObjects = useEditorStore.getState().objects
      const selectedId = useEditorStore.getState().selectedId
      const vcamData = useEditorStore.getState().virtualCamera

      const gizmoCamDrag = gizmo.dragging && gizmo.object === virtCamera
      if (!gizmoCamDrag) applyVirtualCameraAtTime(t, vcamData, virtCamera)

      for (const obj of liveObjects) {
        if (!obj.mesh) continue
        const gizmoObj = gizmo.dragging && gizmo.object === obj.mesh
        if (!gizmoObj) applyObjectTransformAtTime(t, obj)
        ensureShadowsOnObjectMeshes([{ mesh: obj.mesh, subMeshShadow: obj.subMeshShadow }])
        if (!scene.children.includes(obj.mesh)) scene.add(obj.mesh)
      }

      if (selectedId === VIRTUAL_CAMERA_ID) {
        gizmo.enabled = true
        if (lastGizmoObject !== virtCamera) {
          gizmo.attach(virtCamera)
          lastGizmoObject = virtCamera
        }
      } else {
        const selected = liveObjects.find((o) => o.id === selectedId)
        gizmo.enabled = true
        if (selected?.mesh) {
          if (lastGizmoObject !== selected.mesh) {
            gizmo.attach(selected.mesh)
            lastGizmoObject = selected.mesh
          }
        } else {
          gizmo.enabled = false
          gizmo.detach()
          lastGizmoObject = null
        }
      }

      stripViewfinderObjectEffects(liveObjects)
      controls.update()
      mainRenderer.render(scene, userCamera)
      applyViewfinderMeshEffects(liveObjects, stack)

      const pipW = pipRenderer.domElement.clientWidth
      const pipH = pipRenderer.domElement.clientHeight
      if (pipW > 0 && pipH > 0) {
        renderViewfinderFrame(
          useEditorStore.getState().virtualCamera.postProcessing,
          pipRenderer,
          scene,
          virtCamera,
          viewfinder,
          delta
        )
      }

      stripViewfinderObjectEffects(liveObjects)
      for (const obj of liveObjects) {
        if (!obj.mesh) continue
        const gizmoObj = gizmo.dragging && gizmo.object === obj.mesh
        if (!gizmoObj) applyObjectTransformAtTime(t, obj)
      }
      if (!gizmoCamDrag) applyVirtualCameraAtTime(t, useEditorStore.getState().virtualCamera, virtCamera)

      rafId = requestAnimationFrame(animate)
    }

    rafId = requestAnimationFrame(animate)

    const handleMainResize = () => {
      const w = container.clientWidth
      const h = container.clientHeight
      if (w === 0 || h === 0) return
      userCamera.aspect = w / h
      userCamera.updateProjectionMatrix()
      mainRenderer.setSize(w, h)
    }
    const roMain = new ResizeObserver(handleMainResize)
    roMain.observe(container)

    const roPip = new ResizeObserver(handlePipResize)
    roPip.observe(pipMount)
    handleMainResize()
    handlePipResize()
    pruneRemovedObjectsFromScene()

    return () => {
      cancelAnimationFrame(rafId)
      unsubStore()
      roMain.disconnect()
      roPip.disconnect()
      transformControl.dispose()
      scene.remove(gizmoHelper)
      viewfinder.pixelatedPass.dispose()
      viewfinder.bloomPass.dispose()
      viewfinder.ditherPass.dispose()
      viewfinder.outputPass.dispose()
      viewfinder.composer.dispose()
      mainRenderer.dispose()
      pipRenderer.dispose()
      if (mainRenderer.domElement.parentNode) mainRenderer.domElement.remove()
      if (pipRenderer.domElement.parentNode) pipRenderer.domElement.remove()
      registerSceneForExport(null)
    }
  }, [pipMountEl])

  return <div ref={containerRef} id="canvas-container" className="relative z-0 h-full w-full min-h-0" />
}
