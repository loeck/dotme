import {
  DataUtils,
  HalfFloatType,
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  ReinhardToneMapping,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three'

import { sampleMoonLight } from '../src/scene/moon-light'
import { createSkyMaterial } from '../src/scene/sky-material'
import { VolumetricClouds, CLOUD_SAMPLING_GLSL } from '../src/scene/volumetric-clouds'
import { sampleWindField, WIND_FIELD_GLSL } from '../src/scene/water-surface'
import { createWindUniforms, updateWindUniforms, WindModel, WIND_BEARING } from '../src/scene/wind'

const vertex =
  'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }'

export async function exerciseAtmosphere(mobile: boolean) {
  const renderer = new WebGLRenderer()
  renderer.setSize(16, 16)
  const scene = new Scene()
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const geometry = new PlaneGeometry(2, 2)
  const windUniforms = createWindUniforms()
  const material = new ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: `${WIND_FIELD_GLSL}
      uniform vec2 uPoint; uniform float uFootprint;
      void main() { gl_FragColor = windField(uPoint, uFootprint); }`,
    uniforms: {
      ...windUniforms,
      uTime: { value: 0 },
      uPoint: { value: new Vector2() },
      uFootprint: { value: 0 },
    },
    depthTest: false,
    depthWrite: false,
  })
  const quad = new Mesh(geometry, material)
  scene.add(quad)
  const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false })
  let maximumError = 0
  const configurations = [{ meanSpeed: 0.6 }, { meanSpeed: 6 }, { bearing: WIND_BEARING + Math.PI }]
  for (const configuration of configurations) {
    const wind = new WindModel(9182, configuration)
    for (const time of [0, 7.31, 23.12]) {
      const state = wind.sample(time)
      updateWindUniforms(windUniforms, state)
      material.uniforms.uTime!.value = time
      for (const [x, z, footprint] of [
        [0, 0, 0],
        [3.7, -17.3, 0],
        [-22, -63, 0.3],
      ]) {
        material.uniforms.uPoint!.value.set(x, z)
        material.uniforms.uFootprint!.value = footprint
        renderer.setRenderTarget(target)
        renderer.render(scene, camera)
        const data = new Uint16Array(4)
        // The next draw changes this same target.
        // eslint-disable-next-line no-await-in-loop
        await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1, data)
        const cpu = sampleWindField(x!, z!, time, state, footprint)
        cpu.forEach((value, i) => {
          maximumError = Math.max(maximumError, Math.abs(value - DataUtils.fromHalfFloat(data[i]!)))
        })
      }
    }
  }
  target.dispose()
  material.dispose()
  const clouds = new VolumetricClouds(renderer, 9182, mobile, new WindModel(9182))
  const sampler = new ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: `varying vec2 vUv;
      ${CLOUD_SAMPLING_GLSL}
      void main() {
        float azimuth = vUv.x * 6.28318530718;
        float height = 0.08 + vUv.y * 0.91;
        vec3 direction = vec3(sin(azimuth) * sqrt(1.0-height*height), height, cos(azimuth) * sqrt(1.0-height*height));
        gl_FragColor = sampleClouds(direction);
      }`,
    uniforms: clouds.uniforms,
    depthTest: false,
    depthWrite: false,
  })
  quad.material = sampler
  const cloudTarget = new WebGLRenderTarget(96, 48, { depthBuffer: false })
  const capture = async (time: number) => {
    renderer.setRenderTarget(null)
    clouds.update(time)
    renderer.setRenderTarget(cloudTarget)
    renderer.render(scene, camera)
    const pixels = new Uint8Array(96 * 48 * 4)
    await renderer.readRenderTargetPixelsAsync(cloudTarget, 0, 0, 96, 48, pixels)
    return pixels
  }
  const initial = await capture(0)
  const mid = await capture(0.5 / clouds.profile.hz)
  const next = await capture(1 / clouds.profile.hz)
  const nearBoundary = await capture(1 / clouds.profile.hz - 0.000001)
  const later = await capture(15)
  const again = await capture(0)
  let interpolationError = 0,
    continuityError = 0,
    repeatError = 0,
    motion = 0
  let minTransmission = 255,
    maxTransmission = 0
  for (let i = 0; i < initial.length; i++) {
    interpolationError = Math.max(
      interpolationError,
      Math.abs(mid[i]! - (initial[i]! + next[i]!) / 2),
    )
    continuityError = Math.max(continuityError, Math.abs(nearBoundary[i]! - next[i]!))
    repeatError = Math.max(repeatError, Math.abs(again[i]! - initial[i]!))
    motion += Math.abs(later[i]! - initial[i]!) / initial.length
    if (i % 4 === 3) {
      minTransmission = Math.min(minTransmission, initial[i]!)
      maxTransmission = Math.max(maxTransmission, initial[i]!)
    }
  }
  // Probe both sides of every upper-hemisphere cube edge at almost identical rays.
  sampler.fragmentShader = `${CLOUD_SAMPLING_GLSL}
    uniform vec3 uRay; void main() { gl_FragColor = sampleClouds(normalize(uRay)); }`
  sampler.uniforms.uRay = { value: new Vector3() }
  sampler.needsUpdate = true
  cloudTarget.setSize(1, 1)
  let seamError = 0
  for (const ray of [
    [1, 1, 0.3],
    [-1, 1, 0.3],
    [0.3, 1, 1],
    [0.3, 1, -1],
    [1, 0.5, 1],
    [-1, 0.5, -1],
    [1, 0.5, -1],
    [-1, 0.5, 1],
  ]) {
    const pairs: Uint8Array[] = []
    for (const delta of [-0.00001, 0.00001]) {
      sampler.uniforms.uRay!.value.set(
        ray[0]! + (Math.abs(ray[0]!) === 1 ? delta : 0),
        ray[1]! + (Math.abs(ray[0]!) === 1 ? 0 : delta),
        ray[2]!,
      )
      renderer.setRenderTarget(cloudTarget)
      renderer.render(scene, camera)
      const pixel = new Uint8Array(4)
      // Two different draws straddling the face boundary.
      // eslint-disable-next-line no-await-in-loop
      await renderer.readRenderTargetPixelsAsync(cloudTarget, 0, 0, 1, 1, pixel)
      pairs.push(pixel)
    }
    for (let i = 0; i < 4; i++)
      seamError = Math.max(seamError, Math.abs(pairs[0]![i]! - pairs[1]![i]!))
  }
  clouds.dispose()
  cloudTarget.dispose()
  sampler.dispose()
  geometry.dispose()
  renderer.dispose()
  return {
    maximumError,
    interpolationError,
    continuityError,
    repeatError,
    motion,
    minTransmission,
    maxTransmission,
    seamError,
  }
}

let experiment:
  | {
      renderer: WebGLRenderer
      clouds: VolumetricClouds
      scene: Scene
      camera: PerspectiveCamera
      material: ShaderMaterial
      geometry: SphereGeometry
    }
  | undefined
export function startCloudExperiment(mobile: boolean, scenario: 'weak' | 'strong' | 'reverse') {
  stopCloudExperiment()
  const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
  renderer.setSize(innerWidth, innerHeight)
  renderer.toneMapping = ReinhardToneMapping
  document.querySelector('#scene')!.append(renderer.domElement)
  const wind = new WindModel(9182, {
    meanSpeed: scenario === 'weak' ? 0.6 : 6,
    bearing: scenario === 'reverse' ? WIND_BEARING + Math.PI : WIND_BEARING,
  })
  const clouds = new VolumetricClouds(renderer, 9182, mobile, wind)
  const material = createSkyMaterial(9182, mobile, clouds)
  const geometry = new SphereGeometry(1, 32, 16)
  const scene = new Scene()
  const sky = new Mesh(geometry, material)
  sky.frustumCulled = false
  scene.add(sky)
  const camera = new PerspectiveCamera(65, innerWidth / innerHeight, 0.1, 2)
  camera.lookAt(-35, 48, -20)
  experiment = { renderer, clouds, scene, camera, material, geometry }
  renderCloudExperiment(0)
}
export function renderCloudExperiment(time: number, translate = false) {
  const { renderer, clouds, scene, camera, material } = experiment!
  clouds.update(time)
  material.uniforms.uTime!.value = time
  const moon = sampleMoonLight(time)
  material.uniforms.uMoonDirection!.value.copy(moon.offset).normalize()
  material.uniforms.uMoonIntensity!.value = moon.intensity
  camera.position.set(translate ? 50 : 0, translate ? 20 : 0, 0)
  camera.updateMatrixWorld()
  renderer.render(scene, camera)
}
export function stopCloudExperiment() {
  if (!experiment) return
  experiment.clouds.dispose()
  experiment.material.dispose()
  experiment.geometry.dispose()
  experiment.renderer.domElement.remove()
  experiment.renderer.dispose()
  experiment = undefined
}
