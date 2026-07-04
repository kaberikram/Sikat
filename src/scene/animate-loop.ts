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
}) {
  let lastGizmoObject: THREE.Object3D | null = null
  let lastTime = performance.now()
  let rafId = 0

  const animate = (now: number) => {
    const delta = (now - lastTime) / 1000
    lastTime = now

    const { isPlaying, isRolling, cameraOpMode } = useEditorStore.getState()
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
      rafId = requestAnimationFrame(animate)
      return
    }

    const stack = useEditorStore.getState().virtualCamera.postProcessing
    const liveObjects = useEditorStore.getState().objects
    const selectedId = useEditorStore.getState().selectedId
    const vcamData = useEditorStore.getState().virtualCamera
    const lighting = useEditorStore.getState().lighting
    const liveCamOp = cameraOpMode || isRolling

    ctx.controls.enabled = !cameraOpMode

    ctx.ambientLight.color.set(lighting.ambient.color)
    ctx.ambientLight.intensity = lighting.ambient.intensity
    ctx.directionalLight.color.set(lighting.key.color)
    ctx.directionalLight.intensity = lighting.key.intensity
    ctx.directionalLight.position.set(...lighting.key.position)
    ;(ctx.scene.background as THREE.Color).set(lighting.background)

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

    if (selectedId === VIRTUAL_CAMERA_ID) {
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

    // Agent cursors ride layer 1 (main viewport only) — update before the main
    // render, and after object transforms so a cursor lands on its live target.
    ctx.agentCursors.update(now)
    updateStageMarker(ctx.stageMarker)

    ctx.controls.update()
    ctx.mainRenderer.render(ctx.scene, ctx.userCamera)

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

    rafId = requestAnimationFrame(animate)
  }

  rafId = requestAnimationFrame(animate)
  return () => cancelAnimationFrame(rafId)
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
