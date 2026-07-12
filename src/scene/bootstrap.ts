import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { defaultUserCameraPosition, useEditorStore, VIRTUAL_CAMERA_ID } from '../store'
import { createViewfinderComposer } from '../pip-composer'
import { registerSceneForExport } from '../scene-export-registry'
import {
  createViewfinderBackdropMesh,
  EDITOR_LAYER,
  tagSceneInfrastructure,
  VIEWFINDER_BACKDROP_LAYER,
} from './infrastructure'
import { ensureShadowsOnObjectMeshes } from './shadows'
import { setupGizmo } from './setup-gizmo'
import { setupPicking } from './setup-picking'
import { createAnimateLoop, subscribeShadowSync } from './animate-loop'
import { createAgentCursors } from './agent-cursors'
import { createStageMarker, disposeStageMarker } from './stage-marker'
import { bindFlyControls } from './fly-controls'
import { createCamcorderRig } from './xr/camcorder-rig'
import { createReviewScreen } from './xr/review-screen'
import { initXrSession } from './xr/xr-session'
import { createXrViewfinder } from './xr/xr-viewfinder'

export function bootstrapScene(container: HTMLDivElement, pipMount: HTMLDivElement) {
  container.replaceChildren()

  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#f2f2f2')

  const { stage } = useEditorStore.getState()
  const cameraFar = Math.max(5000, stage.radius * 200)
  const userCamera = new THREE.PerspectiveCamera(75, 1, 0.1, cameraFar)
  const defaultSceneFocus = new THREE.Vector3(...stage.position)
  userCamera.position.set(...defaultUserCameraPosition(stage.radius))
  userCamera.lookAt(defaultSceneFocus)
  userCamera.layers.enable(0)
  // Layer 3 = editor chrome. Do NOT use 1/2 — WebXR reserves those for left/right eyes.
  userCamera.layers.enable(EDITOR_LAYER)

  const virtCamera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, cameraFar)
  virtCamera.layers.set(0)
  virtCamera.layers.enable(VIEWFINDER_BACKDROP_LAYER)
  virtCamera.userData.id = VIRTUAL_CAMERA_ID
  const vc0 = useEditorStore.getState().virtualCamera
  virtCamera.position.set(...vc0.position)
  virtCamera.rotation.set(...vc0.rotation)
  virtCamera.fov = vc0.fov
  virtCamera.updateProjectionMatrix()
  scene.add(virtCamera)

  const camAxes = new THREE.AxesHelper(Math.max(0.75, stage.radius * 0.03))
  camAxes.layers.set(EDITOR_LAYER)
  virtCamera.add(camAxes)

  // Physical stand-in for scene.background — WebXR passthrough sessions force
  // every clear (including offscreen viewfinder RTs) to transparent black, so
  // a flat clear color alone can't give the virt-cam feed an opaque backdrop.
  const virtCamBackdrop = createViewfinderBackdropMesh(cameraFar * 0.9)
  virtCamera.add(virtCamBackdrop)

  const mainRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  mainRenderer.setClearColor(0x000000, 0)
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

  const { transformControl, isGizmoDragged, clearGizmoDrag } = setupGizmo(
    scene,
    userCamera,
    mainRenderer.domElement,
    controls
  )

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.8)
  tagSceneInfrastructure(ambientLight)
  scene.add(ambientLight)
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1.5)
  const keyPos = useEditorStore.getState().lighting.key.position
  directionalLight.position.set(...keyPos)
  directionalLight.castShadow = true
  directionalLight.shadow.mapSize.set(1024, 1024)
  tagSceneInfrastructure(directionalLight)
  scene.add(directionalLight)

  if (useEditorStore.getState().objects.length === 0) {
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 32),
      new THREE.MeshToonMaterial({ color: 0x0076ff })
    )
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
      if (child.userData?.isSceneInfrastructure) return
      const id = child.userData?.id as string | undefined
      if (id === VIRTUAL_CAMERA_ID) return
      if (id && !objectIds.has(id)) scene.remove(child)
    })
  }

  const unsubStore = useEditorStore.subscribe(() => pruneRemovedObjectsFromScene())
  const unsubShadows = subscribeShadowSync()
  ensureShadowsOnObjectMeshes(useEditorStore.getState().objects)

  const agentCursors = createAgentCursors(scene)
  const stageMarker = createStageMarker(scene)
  const unbindFly = bindFlyControls(mainRenderer.domElement)

  const camcorderRig = createCamcorderRig(scene, userCamera, virtCamera)
  const xrViewfinderComposer = createViewfinderComposer(
    scene,
    virtCamera,
    mainRenderer,
    mainRenderer.getPixelRatio()
  )
  const xrViewfinder = createXrViewfinder(xrViewfinderComposer)
  const reviewScreen = createReviewScreen(scene, mainRenderer, cameraFar)
  camcorderRig.setTakeEndedHandler((takeStart, takeEnd, head) => {
    reviewScreen.showAfterTake(takeStart, takeEnd, head)
  })
  camcorderRig.setSuppressRec(() => reviewScreen.isOpen())
  const disposeXr = initXrSession(mainRenderer, camcorderRig)

  const stopAnimate = createAnimateLoop({
    scene,
    userCamera,
    virtCamera,
    mainRenderer,
    pipRenderer,
    viewfinder,
    controls,
    transformControl,
    ambientLight,
    directionalLight,
    agentCursors,
    stageMarker,
    camcorderRig,
    xrViewfinder,
    reviewScreen,
    virtCamBackdrop,
  })

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

  const teardownPicking = setupPicking(
    scene,
    userCamera,
    mainRenderer.domElement,
    isGizmoDragged,
    clearGizmoDrag
  )

  return () => {
    teardownPicking()
    stopAnimate()
    agentCursors.dispose()
    disposeStageMarker(stageMarker, scene)
    unbindFly()
    disposeXr()
    camcorderRig.dispose()
    xrViewfinder.dispose()
    reviewScreen.dispose()
    unsubStore()
    unsubShadows()
    roMain.disconnect()
    roPip.disconnect()
    transformControl.dispose()
    scene.remove(transformControl.getHelper())
    viewfinder.pixelatedPass.dispose()
    viewfinder.bloomPass.dispose()
    viewfinder.ditherPass.dispose()
    viewfinder.outputPass.dispose()
    viewfinder.composer.dispose()
    virtCamBackdrop.geometry.dispose()
    ;(virtCamBackdrop.material as THREE.Material).dispose()
    mainRenderer.dispose()
    pipRenderer.dispose()
    if (mainRenderer.domElement.parentNode) mainRenderer.domElement.remove()
    if (pipRenderer.domElement.parentNode) pipRenderer.domElement.remove()
    registerSceneForExport(null)
  }
}
