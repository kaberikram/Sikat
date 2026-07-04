import * as THREE from 'three'
import { applyLiveCameraPose } from '../director/camera-pose'
import { STAGE_RADIUS, useEditorStore } from '../store'

const MOVE_SPEED = STAGE_RADIUS
const FAST_MULT = 3
const LOOK_SENS = 0.004

const HELD = new Set<string>()
let dragging = false
let lastX = 0
let lastY = 0
let bound = false

function isTyping(): boolean {
  const el = document.activeElement
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
}

function onKeyDown(e: KeyboardEvent): void {
  if (!useEditorStore.getState().cameraOpMode || isTyping()) return
  HELD.add(e.code)
}

function onKeyUp(e: KeyboardEvent): void {
  HELD.delete(e.code)
}

function onPointerDown(e: PointerEvent): void {
  if (!useEditorStore.getState().cameraOpMode || e.button !== 0 || isTyping()) return
  dragging = true
  lastX = e.clientX
  lastY = e.clientY
}

function onPointerUp(): void {
  dragging = false
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging || !useEditorStore.getState().cameraOpMode) return
  const dx = e.clientX - lastX
  const dy = e.clientY - lastY
  lastX = e.clientX
  lastY = e.clientY
  const vc = useEditorStore.getState().virtualCamera
  const pitch = vc.rotation[0] - dy * LOOK_SENS
  const yaw = vc.rotation[1] - dx * LOOK_SENS
  applyLiveCameraPose({ rotation: [pitch, yaw, 0] })
}

function moveAxis(delta: number, dt: number): void {
  const st = useEditorStore.getState()
  const vc = st.virtualCamera
  const speed = MOVE_SPEED * (HELD.has('ShiftLeft') || HELD.has('ShiftRight') ? FAST_MULT : 1)
  const step = speed * dt

  const yaw = vc.rotation[1]
  const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).normalize()
  const right = new THREE.Vector3(forward.z, 0, -forward.x)

  const move = new THREE.Vector3(...vc.position)

  if (HELD.has('KeyW') || HELD.has('ArrowUp')) move.addScaledVector(forward, step)
  if (HELD.has('KeyS') || HELD.has('ArrowDown')) move.addScaledVector(forward, -step)
  if (HELD.has('KeyA') || HELD.has('ArrowLeft')) move.addScaledVector(right, -step)
  if (HELD.has('KeyD') || HELD.has('ArrowRight')) move.addScaledVector(right, step)
  if (HELD.has('KeyE')) move.y += step
  if (HELD.has('KeyQ')) move.y -= step

  applyLiveCameraPose({ position: [move.x, move.y, move.z] })
}

let lastTick = performance.now()
let rafId = 0

function tick(now: number): void {
  const dt = Math.min(0.05, (now - lastTick) / 1000)
  lastTick = now
  if (useEditorStore.getState().cameraOpMode && HELD.size > 0 && !isTyping()) moveAxis(0, dt)
  rafId = requestAnimationFrame(tick)
}

export function bindFlyControls(canvas: HTMLCanvasElement): () => void {
  if (bound) return () => {}
  bound = true
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  canvas.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointermove', onPointerMove)
  lastTick = performance.now()
  rafId = requestAnimationFrame(tick)

  return () => {
    bound = false
    cancelAnimationFrame(rafId)
    HELD.clear()
    dragging = false
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    canvas.removeEventListener('pointerdown', onPointerDown)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointermove', onPointerMove)
  }
}
