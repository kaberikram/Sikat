import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { RenderPixelatedPass } from 'three/examples/jsm/postprocessing/RenderPixelatedPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import type { PostProcessingStack } from './store'

function getDefaultPixelRatio() {
  if (typeof window === 'undefined') return 1
  return Math.min(window.devicePixelRatio, 2)
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
}

/**
 * One EffectComposer for the viewfinder (virtual camera) — shared setup for live PiP and offline export.
 */
export function createViewfinderComposer(
  scene: THREE.Scene,
  virtualCamera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer,
  pixelRatio = getDefaultPixelRatio()
): {
  renderPass: RenderPass
  pixelatedPass: RenderPixelatedPass
  bloomPass: UnrealBloomPass
  ditherPass: ShaderPass
  outputPass: OutputPass
  composer: EffectComposer
  /** Last size passed to composer.setSize — lets hot paths skip redundant calls. */
  composerWidth: number
  composerHeight: number
} {
  const composer = new EffectComposer(renderer)
  composer.setPixelRatio(pixelRatio)
  const renderPass = new RenderPass(scene, virtualCamera)
  const pixelatedPass = new RenderPixelatedPass(8, scene, virtualCamera, {
    normalEdgeStrength: 0.25,
    depthEdgeStrength: 0.35,
  })
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.9, 0.4, 0.18)
  const ditherPass = new ShaderPass(DitherShader)
  const outputPass = new OutputPass()
  renderPass.enabled = true
  pixelatedPass.enabled = false
  bloomPass.enabled = false
  ditherPass.enabled = false
  outputPass.enabled = false
  composer.addPass(renderPass)
  composer.addPass(pixelatedPass)
  composer.addPass(bloomPass)
  composer.addPass(ditherPass)
  composer.addPass(outputPass)
  return {
    renderPass,
    pixelatedPass,
    bloomPass,
    ditherPass,
    outputPass,
    composer,
    composerWidth: 0,
    composerHeight: 0,
  }
}

export function updateViewfinderComposerFromStack(
  stack: PostProcessingStack,
  renderer: THREE.WebGLRenderer,
  {
    renderPass,
    pixelatedPass,
    bloomPass,
    ditherPass,
    outputPass,
  }: {
    renderPass: RenderPass
    pixelatedPass: RenderPixelatedPass
    bloomPass: UnrealBloomPass
    ditherPass: ShaderPass
    outputPass: OutputPass
  },
  renderSize?: THREE.Vector2
) {
  const p = stack.pixelate
  const b = stack.bloom
  const d = stack.dither

  const needsPixelate = p.enabled
  const needsBloom = b.enabled
  const needsDither = d.enabled
  const needsComposer = needsPixelate || needsBloom || needsDither

  if (needsPixelate) {
    pixelatedPass.setPixelSize(p.pixelSize)
    pixelatedPass.normalEdgeStrength = p.normalEdge
    pixelatedPass.depthEdgeStrength = p.depthEdge
  }
  if (needsBloom) {
    bloomPass.strength = b.strength
    bloomPass.radius = b.radius
    bloomPass.threshold = b.threshold
  }
  if (needsDither) {
    const size = renderSize ?? renderer.getSize(new THREE.Vector2())
    const pr = renderer.getPixelRatio()
    ditherPass.uniforms.resolution.value.set(size.x * pr, size.y * pr)
    ditherPass.uniforms.pixelSize.value = d.pixelSize
    ditherPass.uniforms.levels.value = d.levels
    ditherPass.uniforms.strength.value = d.strength
    ditherPass.uniforms.monochrome.value = d.monochrome ? 1 : 0
  }

  renderPass.enabled = !needsPixelate
  pixelatedPass.enabled = needsPixelate
  bloomPass.enabled = needsBloom
  ditherPass.enabled = needsDither
  outputPass.enabled = needsComposer
}

export function viewfinderShouldUseComposer(stack: PostProcessingStack): boolean {
  return (
    stack.pixelate.enabled
    || stack.bloom.enabled
    || stack.dither.enabled
  )
}

export function renderViewfinderFrame(
  stack: PostProcessingStack,
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  virtualCamera: THREE.PerspectiveCamera,
  passes: ReturnType<typeof createViewfinderComposer>,
  delta: number,
  renderSize?: THREE.Vector2
) {
  updateViewfinderComposerFromStack(stack, renderer, passes, renderSize)
  if (viewfinderShouldUseComposer(stack)) passes.composer.render(delta)
  else renderer.render(scene, virtualCamera)
}
