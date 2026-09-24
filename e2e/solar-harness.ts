import {
  BoxGeometry,
  Color,
  DataUtils,
  DepthTexture,
  DirectionalLight,
  HalfFloatType,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  ShaderMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  UnsignedIntType,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three'

import { CLOUD_SHADOW_GLSL } from '../src/scene/cloud-shadows'
import { sampleLighting } from '../src/scene/lighting'
import { CLOUD_SAMPLING_GLSL, VolumetricClouds } from '../src/scene/volumetric-clouds'
import { VolumetricLight } from '../src/scene/volumetric-light'
import { VoxelLandscapeEngine } from '../src/scene/VoxelLandscapeEngine'
import { WindModel } from '../src/scene/wind'

export async function exerciseSunVolume() {
  const renderer = new WebGLRenderer()
  renderer.setSize(64, 64)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = PCFShadowMap
  const scene = new Scene()
  scene.background = new Color(0)
  const camera = new PerspectiveCamera(50, 1, 0.1, 300)
  camera.position.set(0, 4, 14)
  camera.lookAt(0, 4, -60)
  camera.updateMatrixWorld()
  const light = new DirectionalLight(0xffffff, 4.5)
  const state = sampleLighting(12 * 3600)
  state.sunDirection.set(0.25, 0.5, -1).normalize()
  light.position.copy(state.sunDirection).multiplyScalar(180)
  light.castShadow = true
  Object.assign(light.shadow.camera, { left: -120, right: 120, top: 120, bottom: -120, far: 400 })
  light.shadow.camera.updateProjectionMatrix()
  light.shadow.mapSize.set(512, 512)
  scene.add(light, light.target)
  const material = new MeshBasicMaterial({ color: 0 })
  const geometry = new BoxGeometry(1, 1, 1)
  const wall = new Mesh(geometry, material)
  wall.position.set(0, 4, -60)
  wall.scale.set(140, 140, 1)
  scene.add(wall)
  const blocker = new Mesh(geometry, material)
  blocker.position.set(8, 19, -42)
  blocker.scale.set(40, 1, 40)
  blocker.castShadow = true
  scene.add(blocker)
  const input = new WebGLRenderTarget(64, 64, {
    type: HalfFloatType,
    depthTexture: new DepthTexture(64, 64, UnsignedIntType),
  })
  const clouds = new VolumetricClouds(
    renderer,
    9182,
    true,
    new WindModel(9182),
    () => state,
    'clear',
  )
  clouds.update(0)
  const clearScene = new Scene()
  const clearGeometry = new PlaneGeometry(2, 2)
  const clearMaterial = new ShaderMaterial({
    uniforms: { ...clouds.uniforms, ...clouds.shadows.uniforms },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `${CLOUD_SAMPLING_GLSL}\n${CLOUD_SHADOW_GLSL}
      void main() { vec4 cloud = sampleClouds(vec3(0.0, 1.0, 0.0));
      gl_FragColor = vec4(cloud.a, cloudShadow(vec3(0.0)), length(cloud.rgb), 1.0); }`,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  clearScene.add(new Mesh(clearGeometry, clearMaterial))
  const clearTarget = new WebGLRenderTarget(1, 1, { depthBuffer: false })
  renderer.setRenderTarget(clearTarget)
  renderer.render(clearScene, new OrthographicCamera(-1, 1, 1, -1, 0, 1))
  const clearPixel = new Uint8Array(4)
  await renderer.readRenderTargetPixelsAsync(clearTarget, 0, 0, 1, 1, clearPixel)
  clearGeometry.dispose()
  clearMaterial.dispose()
  clearTarget.dispose()
  const volumes = [16, 32, 128].map((steps) => {
    const volume = new VolumetricLight(renderer, true, clouds.shadows.uniforms, 0.006, steps)
    volume.resize(64, 64)
    volume.update(state)
    return volume
  })
  const capture = async (volume: VolumetricLight) => {
    renderer.setRenderTarget(input)
    renderer.render(scene, camera)
    volume.render(renderer, input, camera, light)
    const data = new Uint16Array(32 * 32 * 4)
    await renderer.readRenderTargetPixelsAsync(volume.airTarget, 0, 0, 32, 32, data)
    return Array.from(data, (value, index) => {
      const decoded = DataUtils.fromHalfFloat(value)
      return index % 4 === 3 ? decoded : decoded * decoded * 16
    })
  }
  const profiles: number[][] = []
  for (const volume of volumes) {
    // Each read follows its own volume integration.
    // eslint-disable-next-line no-await-in-loop
    profiles.push(await capture(volume))
  }
  const reference = profiles[2]!
  const relativeErrors = profiles.slice(0, 2).map((pixels) => {
    let error = 0,
      energy = 0
    for (let i = 0; i < pixels.length; i++)
      if (i % 4 !== 3) {
        error += Math.abs(pixels[i]! - reference[i]!)
        energy += reference[i]!
      }
    return error / energy
  })
  blocker.visible = false
  const unoccluded = await capture(volumes[1]!)
  const center = (16 * 32 + 16) * 4
  wall.position.z = 6
  const nearSurface = await capture(volumes[1]!)
  wall.position.z = -60
  const homogeneous: number[][] = []
  for (const volume of volumes) {
    // Same medium with different integration resolutions.
    // eslint-disable-next-line no-await-in-loop
    homogeneous.push(await capture(volume))
  }
  const homogeneousError = Math.max(
    ...homogeneous[0]!.map((value, i) => Math.abs(value - homogeneous[2]![i]!)),
  )
  // HDR brightness changes the half-float ULP. Compare relative energy rather
  // than an absolute tolerance tied to the former, dimmer solar exposure.
  const homogeneousRelativeError = Math.max(
    ...homogeneous[0]!.map(
      (value, i) => Math.abs(value - homogeneous[2]![i]!) / Math.max(0.001, homogeneous[2]![i]!),
    ),
  )
  const result = {
    relativeErrors,
    homogeneousError,
    homogeneousRelativeError,
    shadowed: reference[center]!,
    unoccluded: unoccluded[center]!,
    nearRadiance: nearSurface[center]!,
    nearTransmission: nearSurface[center + 3]!,
    farTransmission: unoccluded[center + 3]!,
    clearTransmission: clearPixel[0] === 255 && clearPixel[1] === 255 && clearPixel[2] === 0,
    finite: profiles.flat().every(Number.isFinite),
  }
  for (const volume of volumes) volume.dispose()
  clouds.dispose()
  material.dispose()
  geometry.dispose()
  input.dispose()
  light.shadow.dispose()
  renderer.dispose()
  return result
}

export async function exerciseSceneLighting() {
  const container = document.createElement('div')
  container.style.cssText = 'width:640px;height:360px'
  document.body.append(container)
  let firstFrame!: () => void
  const ready = new Promise<void>((resolve) => {
    firstFrame = resolve
  })
  const engine = new VoxelLandscapeEngine({
    container,
    seed: 9182,
    reducedMotion: true,
    onFirstFrame: firstFrame,
    onContextFailure: () => {
      throw new Error('Context lost')
    },
  })
  await ready
  const state = engine as unknown as {
    renderer: WebGLRenderer
    atmosphere: VolumetricLight
    moon: DirectionalLight
    lampLights: Array<{
      light: { intensity: number; visible: boolean }
      cube: { visible: boolean }
      glow: { visible: boolean }
      glowStrength: { value: number }
    }>
    cursorGlow: { uniforms: { uCursorGlowStrength: { value: number } } }
    depthFocus: { target: WebGLRenderTarget }
    showSun: boolean
    render: (time: number) => void
    solarClock: { initialSeconds: number }
    clouds: { tick: number }
    water: { material: { uniforms: Record<string, { value: unknown }> } }
  }
  const read = async (target: WebGLRenderTarget) => {
    const data = new Uint16Array(target.width * target.height * 4)
    await state.renderer.readRenderTargetPixelsAsync(
      target,
      0,
      0,
      target.width,
      target.height,
      data,
    )
    return Array.from(data, DataUtils.fromHalfFloat)
  }
  const lamps = () => ({
    visible: state.lampLights.filter(
      (lamp) => lamp.cube.visible || lamp.glow.visible || lamp.light.visible,
    ).length,
    energy: state.lampLights.reduce(
      (sum, lamp) => sum + lamp.light.intensity + lamp.glowStrength.value,
      0,
    ),
  })
  const daytimeLamps = lamps()
  const daytimeCursor = state.cursorGlow.uniforms.uCursorGlowStrength.value
  const visibleAir = await read(state.atmosphere.airTarget)
  const visibleIntensity = state.moon.intensity
  state.showSun = false
  state.render(performance.now())
  const hiddenAir = await read(state.atmosphere.airTarget)
  const scenePixels = await read(state.depthFocus.target)
  const hiddenError = visibleAir.reduce(
    (error, value, index) => Math.max(error, Math.abs(value - hiddenAir[index]!)),
    0,
  )
  const finite = scenePixels.every(Number.isFinite)
  // Independently sample both sides of the horizon and midnight, without advancing water.
  const boundaryChanges: number[] = []
  for (const hour of [0, 6, 18]) {
    const means: number[] = []
    for (const seconds of [-0.01, 0.01]) {
      state.solarClock.initialSeconds = hour * 3600 + seconds
      state.clouds.tick = -1
      state.render(performance.now())
      // Rendering and readback must be sequential at these distinct times.
      // eslint-disable-next-line no-await-in-loop
      const pixels = await read(state.depthFocus.target)
      if (!pixels.every(Number.isFinite)) throw new Error('Non-finite horizon radiance')
      means.push(
        pixels.reduce((total, value, i) => total + (i % 4 === 3 ? 0 : value), 0) / pixels.length,
      )
    }
    boundaryChanges.push(Math.abs(means[0]! - means[1]!))
  }
  state.solarClock.initialSeconds = 0
  state.clouds.tick = -1
  state.render(performance.now())
  const nighttimeLamps = lamps()
  state.solarClock.initialSeconds = 12 * 3600
  state.clouds.tick = -1
  state.render(performance.now())
  const returnedDaytimeLamps = lamps()
  const result = {
    hiddenError,
    visibleIntensity,
    finite,
    boundaryChanges,
    daytimeLamps,
    daytimeCursor,
    nighttimeLamps,
    returnedDaytimeLamps,
  }
  engine.dispose()
  container.remove()
  return result
}

/** Isolate solar scattering from the same terrain/cloud field used by the scene. */
export async function captureCloudShafts() {
  const container = document.createElement('div')
  container.style.cssText = 'width:960px;height:540px'
  document.body.style.margin = '0'
  document.body.append(container)
  let firstFrame!: () => void
  const ready = new Promise<void>((resolve) => {
    firstFrame = resolve
  })
  const engine = new VoxelLandscapeEngine({
    container,
    seed: 9182,
    reducedMotion: true,
    onFirstFrame: firstFrame,
    onContextFailure: () => {
      throw new Error('Context lost')
    },
  })
  await ready
  const state = engine as unknown as {
    renderer: WebGLRenderer
    atmosphere: VolumetricLight
    moon: DirectionalLight
    camera: PerspectiveCamera
    depthFocus: { target: WebGLRenderTarget }
    clouds: { shadows: { uniforms: { uCloudShadowStrength: { value: number } } } }
    render: (time: number) => void
  }
  state.render(performance.now())
  const scene = state.renderer.domElement.toDataURL()
  const target = state.atmosphere.airTarget
  const read = async () => {
    const data = new Uint16Array(target.width * target.height * 4)
    await state.renderer.readRenderTargetPixelsAsync(
      target,
      0,
      0,
      target.width,
      target.height,
      data,
    )
    return Array.from(data, (value, i) => {
      const v = DataUtils.fromHalfFloat(value)
      return i % 4 === 3 ? v : v * v * 16
    })
  }
  const shadowed = await read()
  state.clouds.shadows.uniforms.uCloudShadowStrength.value = 0
  state.atmosphere.render(state.renderer, state.depthFocus.target, state.camera, state.moon)
  const clear = await read()
  let loss = 0,
    energy = 0,
    strongestShadow = 0
  const diagnostic = document.createElement('canvas')
  diagnostic.width = target.width
  diagnostic.height = target.height
  const context = diagnostic.getContext('2d')!
  const pixels = context.createImageData(target.width, target.height)
  for (let y = 0; y < target.height; y++)
    for (let x = 0; x < target.width; x++) {
      const i = (y * target.width + x) * 4
      loss += clear[i]! - shadowed[i]!
      energy += clear[i]!
      strongestShadow = Math.max(strongestShadow, 1 - shadowed[i]! / Math.max(0.0001, clear[i]!))
      const output = ((target.height - 1 - y) * target.width + x) * 4
      for (let c = 0; c < 3; c++)
        pixels.data[output + c] = 255 * Math.sqrt(shadowed[i + c]! / (1 + shadowed[i + c]!))
      pixels.data[output + 3] = 255
    }
  context.putImageData(pixels, 0, 0)
  const result = { scene, air: diagnostic.toDataURL(), shadowLoss: loss / energy, strongestShadow }
  engine.dispose()
  container.remove()
  return result
}
