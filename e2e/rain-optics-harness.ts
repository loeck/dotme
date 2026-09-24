import {
  Color,
  DataTexture,
  DataUtils,
  DirectionalLight,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three'
import { Reflector } from 'three/addons/objects/Reflector.js'

import { RAIN_FRAGMENT, RAIN_VERTEX } from '../src/scene/rain-shaders'
import { RAIN_LAYER, RainEffect } from '../src/scene/RainEffect'
import { createWindUniforms } from '../src/scene/wind'

/** Isolate a real production streak: millimetre diameter, metres of depth. */
export function sampleDrop(
  depth: number,
  pixelRatio: number,
  background = 0,
  pixelOffset = 0,
  contactAge = -1,
  reflectionPass = false,
) {
  const size = 256 * pixelRatio
  const renderer = new WebGLRenderer()
  const target = new WebGLRenderTarget(size, size)
  const camera = new PerspectiveCamera(18, 1, 0.1, 100)
  const worldOffset = (pixelOffset * 2 * depth * Math.tan(Math.PI / 20)) / size
  const plane = new PlaneGeometry()
  const geometry = new InstancedBufferGeometry()
  geometry.setIndex(plane.index)
  geometry.setAttribute('position', plane.attributes.position!)
  geometry.setAttribute('uv', plane.attributes.uv!)
  geometry.setAttribute(
    'aDrop',
    new InstancedBufferAttribute(new Float32Array([worldOffset, 0, -depth, 0.003]), 4),
  )
  geometry.setAttribute(
    'aVelocity',
    new InstancedBufferAttribute(new Float32Array([0, -9, 0, 0.3]), 4),
  )
  geometry.instanceCount = 1
  geometry.setAttribute(
    'aContactAge',
    new InstancedBufferAttribute(new Float32Array([contactAge]), 1),
  )
  const material = new ShaderMaterial({
    vertexShader: RAIN_VERTEX,
    fragmentShader: RAIN_FRAGMENT,
    defines: { LAMP_COUNT: 1 },
    uniforms: {
      uResolution: { value: new Vector2(size, size) },
      uPixelRatio: { value: pixelRatio },
      uMoonColor: { value: new Color(1, 1, 1) },
      uMoonDirection: { value: new Vector3(0, 0, 1) },
      uLampPosition: { value: [new Vector3()] },
      uLampColor: { value: [new Color(0)] },
      uOverlay: { value: false },
      uReflectionPass: { value: reflectionPass },
      uDepth: { value: null },
      uOpacity: { value: 1 },
    },
    transparent: true,
    side: DoubleSide,
  })
  const scene = new Scene()
  const mesh = new Mesh(geometry, material)
  mesh.frustumCulled = false
  scene.add(mesh)
  renderer.setRenderTarget(target)
  renderer.setClearColor(new Color(background, background, background))
  renderer.render(scene, camera)
  const pixels = new Uint8Array(size * size * 4)
  renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels)
  const backgroundLevel = pixels[0]!
  let left = size,
    right = 0,
    top = size,
    bottom = 0,
    energy = 0,
    peak = 0
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const value = Math.abs(pixels[(y * size + x) * 4]! - backgroundLevel)
      energy += value
      peak = Math.max(peak, value)
      if (value < 2) continue
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
    }
  material.dispose()
  geometry.dispose()
  plane.dispose()
  target.dispose()
  renderer.dispose()
  return {
    width: (right - left + 1) / pixelRatio,
    length: (bottom - top + 1) / pixelRatio,
    energy,
    peak,
  }
}

/** Exercise the actual nested Reflector render, then the post-lens rain overlay. */
export function sampleReflectedRain() {
  const renderer = new WebGLRenderer({ preserveDrawingBuffer: true })
  renderer.setPixelRatio(2)
  renderer.setClearColor(0, 0)
  const camera = new PerspectiveCamera(50, 4 / 3, 0.1, 100)
  camera.position.set(0, 3, 10)
  camera.lookAt(0, 1, 0)
  const scene = new Scene()
  const mirrorGeometry = new PlaneGeometry(40, 40)
  const mirror = new Reflector(mirrorGeometry, {
    textureWidth: 256,
    textureHeight: 192,
    multisample: 0,
  })
  mirror.rotation.x = -Math.PI / 2
  scene.add(mirror)
  const reflectionCamera = mirror.getReflectionCamera(camera)
  reflectionCamera.layers.enable(RAIN_LAYER)
  const moon = new DirectionalLight(0xffffff, 1)
  moon.position.set(0, 5, 10)
  const blank = new DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1)
  const depth = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
  blank.needsUpdate = depth.needsUpdate = true
  const rain = new RainEffect(
    [],
    true,
    42,
    [],
    moon,
    false,
    {
      ...createWindUniforms(),
      uTime: { value: 0 },
      uState: { value: blank },
      uMask: { value: blank },
      uCell: { value: 0.16 },
    },
    false,
  )
  rain.setRainState({ intensity: 0.1, wind: { x: 0, z: 0 } })
  Object.assign(rain.simulation.drops[0]!, {
    alive: true,
    x: 0,
    y: 2,
    z: 0,
    size: 0.003,
    vx: 0,
    vy: -9,
    vz: 0,
    seed: 0.3,
  })
  rain.update(0, camera, 1)
  scene.add(rain.group)
  const passUniforms: Array<{
    reflection: boolean
    width: number
    height: number
    pixelRatio: number
  }> = []
  rain.group.children[0]!.onAfterRender = (_renderer, _scene, passCamera, _geometry, material) => {
    const uniforms = (material as ShaderMaterial).uniforms
    const size = uniforms.uResolution!.value as Vector2
    passUniforms.push({
      reflection: passCamera === reflectionCamera,
      width: size.x,
      height: size.y,
      pixelRatio: uniforms.uPixelRatio!.value,
    })
  }
  const sample = (width: number, reflectionWidth: number) => {
    renderer.setSize(width, width * 0.75)
    rain.resize(width * 2, width * 1.5)
    mirror.getRenderTarget().setSize(reflectionWidth, reflectionWidth * 0.75)
    const passStart = passUniforms.length
    renderer.render(scene, camera)
    const target = mirror.getRenderTarget()
    const reflected = new Uint16Array(target.width * target.height * 4)
    renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, reflected)
    let reflectionEnergy = 0
    for (let i = 0; i < reflected.length; i += 4)
      reflectionEnergy += DataUtils.fromHalfFloat(reflected[i]!)
    const gl = renderer.getContext()
    const before = new Uint8Array(width * 2 * width * 1.5 * 4)
    const after = new Uint8Array(before.length)
    gl.readPixels(0, 0, width * 2, width * 1.5, gl.RGBA, gl.UNSIGNED_BYTE, before)
    rain.renderOverlay(renderer, scene, camera, depth)
    gl.readPixels(0, 0, width * 2, width * 1.5, gl.RGBA, gl.UNSIGNED_BYTE, after)
    let overlayDifference = 0
    for (let i = 0; i < before.length; i += 4) overlayDifference += Math.abs(after[i]! - before[i]!)
    return { reflectionEnergy, overlayDifference, passes: passUniforms.slice(passStart) }
  }
  const first = sample(320, 256)
  const resized = sample(400, 192)
  const restored = sample(320, 256)
  rain.dispose()
  mirror.dispose()
  mirrorGeometry.dispose()
  blank.dispose()
  depth.dispose()
  renderer.dispose()
  return { first, resized, restored }
}
