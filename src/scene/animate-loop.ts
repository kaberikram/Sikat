import * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { useEditorStore, VIRTUAL_CAMERA_ID } from '../store'
import { applyObjectTransformAtTime, applyVirtualCameraAtTime, applyVirtualCameraBase } from '../timeline-apply'
import { renderViewfinderPass } from './viewfinder-pass'
import { ensureShadowsOnObjectMeshes } from './shadows'
import { updateStageMarker } from './stage-marker'
import type { createViewfinderComposer } from '../pip-composer'
import type { AgentCursors } from './agent-cursors'
import type { CamcorderRig } from './xr/camcorder-rig'
import type { XrViewfinder } from './xr/xr-viewfinder'

type ViewfinderComposer = ReturnType<typeof createViewfinderComposer>

export function createAnimateLoop(ctx: {
  scene: THREE.Scene
  userCamera: THREE.PerspectiveCamera
  virtCamera: THREE.PerspectiveCamera
  mainRenderer: THREE.WebGLRenderer
  pipRenderer: THREE.WebGLRenderer
  viewfinder: ViewfinderComposer
  controls: OrbitControls
  transformControl: TransformControls
  ambientLight: THREE.AmbientLight
  directionalLight: THREE.DirectionalLight
  agentCursors: AgentCursors
  stageMarker: THREE.Group
  camcorderRig: CamcorderRig
  xrViewfinder: XrViewfinder
}) {
  let lastGizmoObject: THREE.Object3D | null = null
  let lastTime = performance.now()

  const animate = (now: number, xrFrame?: XRFrame) => {
    const delta = (now - lastTime) / 1000
    lastTime = now

    const { isPlaying, isRolling, cameraOpMode, xrActive } = useEditorStore.getState()
    if (isPlaying) {
      useEditorStore.setState((state) => {
        const nextTime = state.currentTime + delta
        if (state.isRolling) {
          return {
            currentTime: nextTime,
            duration: Math.max(state.duration, nextTime),
          }
        }
        if (state.playOnceEnd != null) {
          if (nextTime >= state.playOnceEnd) {
            return { currentTime: state.playOnceEnd, isPlaying: false, playOnceEnd: null }
          }
          return { currentTime: nextTime }
        }
        const loopAt = state.clipLoopEnd ?? state.duration
        if (state.playbackLoop) {
          return { currentTime: nextTime % loopAt }
        }
        if (nextTime >= loopAt) {
          return { currentTime: loopAt, isPlaying: false }
        }
        return { currentTime: nextTime }
      })
    }
    const t = useEditorStore.getState().currentTime
    const gizmo = ctx.transformControl
    if (useEditorStore.getState().isExporting) {
      return
    }

    const stack = useEditorStore.getState().virtualCamera.postProcessing
    const liveObjects = useEditorStore.getState().objects
    const selectedId = useEditorStore.getState().selectedId
    const vcamData = useEditorStore.getState().virtualCamera
    const lighting = useEditorStore.getState().lighting
    const liveCamOp = cameraOpMode || isRolling

    ctx.controls.enabled = !cameraOpMode && !xrActive

    ctx.ambientLight.color.set(lighting.ambient.color)
    ctx.ambientLight.intensity = lighting.ambient.intensity
    ctx.directionalLight.color.set(lighting.key.color)
    ctx.directionalLight.intensity = lighting.key.intensity
    ctx.directionalLight.position.set(...lighting.key.position)
    if (xrActive) {
      ctx.scene.background = null
    } else {
      if (!(ctx.scene.background instanceof THREE.Color)) {
        ctx.scene.background = new THREE.Color()
      }
      ctx.scene.background.set(lighting.background)
    }

    if (xrActive) {
      gizmo.enabled = false
      gizmo.detach()
      lastGizmoObject = null
    } else if (selectedId === VIRTUAL_CAMERA_ID) {
      gizmo.enabled = true
      if (lastGizmoObject !== ctx.virtCamera) {
        gizmo.attach(ctx.virtCamera)
        lastGizmoObject = ctx.virtCamera
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

    const gizmoCamDrag = gizmo.dragging && gizmo.object === ctx.virtCamera
    if (!gizmoCamDrag) {
      if (liveCamOp) applyVirtualCameraBase(vcamData, ctx.virtCamera)
      else applyVirtualCameraAtTime(t, vcamData, ctx.virtCamera)
    }

    for (const obj of liveObjects) {
      if (!obj.mesh) continue
      const gizmoObj = gizmo.dragging && gizmo.object === obj.mesh
      if (!gizmoObj) applyObjectTransformAtTime(t, obj)
      if (!ctx.scene.children.includes(obj.mesh)) ctx.scene.add(obj.mesh)
    }

    ctx.agentCursors.update(now)
    updateStageMarker(ctx.stageMarker)

    if (!xrActive) ctx.controls.update()

    if (xrActive && xrFrame) {
      const referenceSpace = ctx.mainRenderer.xr.getReferenceSpace()
      if (referenceSpace) ctx.camcorderRig.update(xrFrame, referenceSpace)

      ctx.xrViewfinder.render({
        renderer: ctx.pipRenderer,
        scene: ctx.scene,
        virtCamera: ctx.virtCamera,
        screenMesh: ctx.camcorderRig.screenMesh,
        objects: liveObjects,
        stack,
        t,
        isObjectGizmoActive: (obj) => gizmo.dragging && gizmo.object === obj.mesh,
      })
    }

    ctx.mainRenderer.render(ctx.scene, ctx.userCamera)

    if (!xrActive) {
      renderViewfinderPass({
        objects: liveObjects,
        stack,
        pipRenderer: ctx.pipRenderer,
        scene: ctx.scene,
        virtCamera: ctx.virtCamera,
        viewfinder: ctx.viewfinder,
        delta,
        t,
        vcData: vcamData,
        isObjectGizmoActive: (obj) => gizmo.dragging && gizmo.object === obj.mesh,
        skipCameraApply: gizmoCamDrag || liveCamOp,
      })
    }
  }

  ctx.mainRenderer.setAnimationLoop(animate)
  return () => ctx.mainRenderer.setAnimationLoop(null)
}

export function subscribeShadowSync() {
  let lastSig = ''
  return useEditorStore.subscribe((state) => {
    const sig = state.objects.map((o) => o.id).join(',') + JSON.stringify(state.objects.map((o) => o.subMeshShadow))
    if (sig === lastSig) return
    lastSig = sig
    ensureShadowsOnObjectMeshes(state.objects)
  })
}
