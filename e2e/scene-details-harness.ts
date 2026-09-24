import {
  Vector3,
  BufferGeometry,
  Float32BufferAttribute,
  ShaderMaterial,
  Points,
  Scene,
  OrthographicCamera,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three'
import type { PerspectiveCamera } from 'three'

import { FISH_RIG_GLSL } from '../src/scene/fish-anatomy'
import { apparentFishSurface } from '../src/scene/fish-pointer'
import type { DetailEnvironment } from '../src/scene/scene-details'
import { VoxelLandscapeEngine } from '../src/scene/VoxelLandscapeEngine'
import { parseWeather } from '../src/scene/weather'

let engine: VoxelLandscapeEngine | undefined

export async function start(
  seed = 42,
  details = true,
  reducedMotion = false,
  rainIntensity = 0,
  windSpeed = 3,
  windBearing?: number,
) {
  stop()
  await new Promise<void>((resolve, reject) => {
    engine = new VoxelLandscapeEngine({
      container: document.querySelector<HTMLDivElement>('#scene')!,
      seed,
      weather: parseWeather(new URLSearchParams(location.search).get('weather')),
      sceneDetails: details,
      wind: { meanSpeed: windSpeed, bearing: windBearing },
      reducedMotion,
      rain: { intensity: rainIntensity, wind: { x: 2, z: 0.5 } },
      onFirstFrame: resolve,
      onContextFailure: () => reject(new Error('Scene context failed')),
    })
  })
}

export function environment(state: Partial<DetailEnvironment>) {
  engine!.setDetailEnvironment(state)
}

export function rain(intensity: number) {
  engine!.setRainState({ intensity, wind: { x: 2, z: 0.5 } })
}

export function resize() {
  engine!.resize()
}

export function fishProbe(visible = true) {
  const state = engine as unknown as {
    camera: PerspectiveCamera
    details: {
      fish: { mesh: { visible: boolean }; poses: Array<{ x: number; y: number; z: number }> }
    }
  }
  const fish = state.details.fish
  fish.mesh.visible = visible
  const pose = fish.poses.find((point) => point.z > -15) ?? fish.poses[0]!
  const point = apparentFishSurface(pose, state.camera.position, new Vector3())
  point.project(state.camera)
  engine!.resize()
  return { x: (point.x * 0.5 + 0.5) * innerWidth, y: (-point.y * 0.5 + 0.5) * innerHeight }
}

export function hideFoam() {
  const state = engine as unknown as { water: { material: ShaderMaterial } }
  const material = state.water.material
  material.fragmentShader = material.fragmentShader.replace(
    'color *= 1.0 - foam;',
    'foam = 0.0; color *= 1.0 - foam;',
  )
  material.needsUpdate = true
  engine!.resize()
}

export function status() {
  // Diagnostics stay in this test-only harness, outside the site's public API.
  const state = engine as unknown as {
    elapsed: number
    water: {
      material: {
        uniforms: { uWaterClarity: { value: number }; uWaterAgitation: { value: number } }
      }
    }
    details?: {
      fish: { count: number }
      fireflies: { mesh: { geometry: { instanceCount: number } } }
      wetness: { wetness: number }
      environment: DetailEnvironment
    }
    renderer: { info: { memory: { geometries: number; textures: number } } }
  }
  return {
    time: state.elapsed,
    clarity: state.water.material.uniforms.uWaterClarity.value,
    agitation: state.water.material.uniforms.uWaterAgitation.value,
    fish: state.details?.fish.count ?? 0,
    fireflies: state.details?.fireflies.mesh.geometry.instanceCount ?? 0,
    wetness: state.details?.wetness.wetness ?? 0,
    environment: state.details?.environment,
    memory: { ...state.renderer.info.memory },
  }
}

export function stop() {
  engine?.dispose()
  engine = undefined
}

/** Execute the production rig on the GPU: the head stays anchored as the tail beats. */
export async function fishRigProbe() {
  const renderer = new WebGLRenderer()
  const geometry = new BufferGeometry()
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute([0, 0, 0.45, 0, 0, 0.45, 0, 0, -0.75, 0, 0, -0.75], 3),
  )
  geometry.setAttribute(
    'aFishJoints',
    new Float32BufferAttribute([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1], 3),
  )
  geometry.setAttribute('aFishPhase', new Float32BufferAttribute([0, Math.PI, 0, Math.PI], 1))
  geometry.setAttribute(
    'aFishMotion',
    new Float32BufferAttribute([1, 0, 0.46, 1, 0, 0.46, 1, 0, 0.46, 1, 0, 0.46], 3),
  )
  geometry.setAttribute('aProbe', new Float32BufferAttribute([0, 1, 2, 3], 1))
  const material = new ShaderMaterial({
    vertexShader: `${FISH_RIG_GLSL}
      attribute float aProbe;
      varying vec3 vPose;
      void main() {
        vPose = fishRig(position, false);
        gl_Position = vec4((aProbe + 0.5) / 4.0 * 2.0 - 1.0, 0.0, 0.0, 1.0);
        gl_PointSize = 1.0;
      }`,
    fragmentShader:
      'varying vec3 vPose; void main() { gl_FragColor = vec4(vPose * 0.25 + 0.5, 1.0); }',
    depthTest: false,
    depthWrite: false,
  })
  const target = new WebGLRenderTarget(4, 1)
  const scene = new Scene()
  const points = new Points(geometry, material)
  points.frustumCulled = false
  scene.add(points)
  try {
    renderer.setRenderTarget(target)
    renderer.render(scene, new OrthographicCamera(-1, 1, 1, -1, 0, 1))
    const pixels = new Uint8Array(16)
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, 4, 1, pixels)
    return Array.from({ length: 4 }, (_, i) => Array.from(pixels.slice(i * 4, i * 4 + 4)))
  } finally {
    material.dispose()
    geometry.dispose()
    target.dispose()
    renderer.dispose()
  }
}

/** Freeze travel to verify visible articulation at the real lake/camera scale. */
export function fishArticulationFrame(phase: number) {
  const state = engine as unknown as {
    details: { fish: import('../src/scene/lake-fish').LakeFish }
  }
  const fish = state.details.fish
  fish.update = () => {}
  for (const mesh of fish.meshes) {
    const phases = mesh.geometry.getAttribute('aFishPhase')
    for (let i = 0; i < phases.count; i++) phases.setX(i, phase)
    phases.needsUpdate = true
  }
  engine!.resize()
}

/** A fully reflective interface must hide every underwater silhouette. */
export function opaqueWater() {
  const state = engine as unknown as { water: { material: ShaderMaterial } }
  const material = state.water.material
  material.fragmentShader = material.fragmentShader.replace(
    'vec3 color = mix(transmitted, reflection, reflectedFraction);',
    'vec3 color = reflection;',
  )
  material.needsUpdate = true
  engine!.resize()
}

/** Advance the production impact controller, then hold a readable breakup frame. */
export function splashFrame(time: number, seekSpray = false) {
  const state = engine as unknown as {
    details: { splashes: import('../src/scene/lake-splashes').LakeSplashes }
    wind: { sample: (time: number) => import('../src/scene/wind').WindState }
    camera: PerspectiveCamera
    elapsed: number
  }
  const splashes = state.details.splashes
  const update = splashes.update.bind(splashes)
  const projected = new Vector3()
  for (let t = 0; t <= time; t += 1 / 60) {
    update(t, state.wind.sample(t), false, 1)
    state.elapsed = t
    // Natural impacts are intermittent, especially with the smaller mobile pool.
    // Inspect an actual airborne phase instead of requiring spray at a fixed second.
    if (seekSpray && t > 1 && splashes.active > 5) {
      const opacity = splashes.mesh.geometry.getAttribute('aSplashOpacity')
      let visible = false
      for (let i = 0; i < opacity.count; i++) {
        if (opacity.getX(i) < 0.5) continue
        const matrix = splashes.mesh.instanceMatrix.array
        if (matrix[i * 16 + 13]! < 0.16) continue
        const visibility = splashes as unknown as {
          visibleFromCamera: (x: number, z: number) => boolean
        }
        if (!visibility.visibleFromCamera(matrix[i * 16 + 12]!, matrix[i * 16 + 14]!)) continue
        projected
          .set(matrix[i * 16 + 12]!, matrix[i * 16 + 13]!, matrix[i * 16 + 14]!)
          .project(state.camera)
        if (Math.abs(projected.x) < 0.85 && Math.abs(projected.y) < 0.9) visible = true
      }
      if (visible) break
    }
  }
  splashes.update = () => {}
  engine!.resize()
  return {
    emitted: splashes.emitted,
    active: splashes.active,
    contacts: splashes.contacts.length,
    landed: splashes.impacts.landed,
    impacts: splashes.impacts.active,
  }
}
export function hideSplashes() {
  const state = engine as unknown as {
    details: { splashes: import('../src/scene/lake-splashes').LakeSplashes }
  }
  state.details.splashes.mesh.visible = state.details.splashes.sheets.visible = false
  engine!.resize()
}

/** Inspect millimetre-scale spray on narrow screens without enlarging the effect itself. */
export function inspectAirborneSpray() {
  const state = engine as unknown as {
    camera: PerspectiveCamera
    details: { splashes: import('../src/scene/lake-splashes').LakeSplashes }
  }
  const { mesh } = state.details.splashes
  const opacity = mesh.geometry.getAttribute('aSplashOpacity')
  const point = new Vector3(),
    target = new Vector3()
  let nearest = Infinity
  for (let i = 0; i < opacity.count; i++) {
    if (opacity.getX(i) < 0.5) continue
    const matrix = mesh.instanceMatrix.array
    point.set(matrix[i * 16 + 12]!, matrix[i * 16 + 13]!, matrix[i * 16 + 14]!)
    const visibility = state.details.splashes as unknown as {
      visibleFromCamera: (x: number, z: number) => boolean
    }
    if (!visibility.visibleFromCamera(point.x, point.z)) continue
    const distance = point.distanceTo(state.camera.position)
    if (distance < nearest) {
      nearest = distance
      target.copy(point)
    }
  }
  if (!Number.isFinite(nearest)) throw new Error('No unobstructed airborne spray')
  const lookAt = state.camera.lookAt.bind(state.camera)
  state.camera.zoom = 3
  state.camera.lookAt = () => lookAt(target)
  engine!.resize()
}

export function hideLandingImpacts() {
  const state = engine as unknown as {
    details: { splashes: import('../src/scene/lake-splashes').LakeSplashes }
  }
  state.details.splashes.impacts.mesh.visible = false
  state.details.splashes.impacts.slopes.visible = false
  engine!.resize()
}

export function hideLandingCrowns() {
  const state = engine as unknown as {
    details: { splashes: import('../src/scene/lake-splashes').LakeSplashes }
  }
  state.details.splashes.impacts.mesh.visible = false
  engine!.resize()
}

/** A fixed wet foreground contact isolates optical quality from random burst timing. */
export function landingFrame(age = 0.22) {
  const state = engine as unknown as {
    hitWater: (x: number, y: number) => Vector3 | null
    details: { splashes: import('../src/scene/lake-splashes').LakeSplashes }
  }
  let point: Vector3 | null = null
  for (const y of [0.95, 0.9, 0.82, 0.75, 0.7, 0.65]) {
    for (const x of [0.5, 0.6, 0.4, 0.7, 0.3, 0.8, 0.2]) {
      const candidate = state.hitWater(innerWidth * x, innerHeight * y)
      if (candidate && (!point || candidate.z > point.z)) point = candidate
    }
  }
  if (!point) throw new Error('No visible wet landing point')
  const splashes = state.details.splashes
  splashes.update = () => {}
  splashes.mesh.visible = splashes.sheets.visible = false
  splashes.impacts.add(point.x, point.z, 100, 1)
  splashes.impacts.update(100 + age)
  engine!.resize()
}

/** Inspect the production passes and shared water uniforms without public controls. */
export async function livingProbe() {
  const state = engine as unknown as {
    camera: PerspectiveCamera
    water: import('../src/scene/lake-water').LakeReflector
    details: import('../src/scene/scene-details').SceneDetails
    renderer: WebGLRenderer
    skyMaterial: ShaderMaterial
    environmentAt: number
    options: { reducedMotion: boolean }
    cancelFrame(): void
    render(now: number): void
  }
  state.cancelFrame()
  state.options.reducedMotion = true
  const leaf = state.details.leaves.mesh
  const passes: string[] = []
  const mirror = state.water.getReflectionCamera(state.camera)
  leaf.onBeforeRender = (_renderer, _scene, camera) => {
    passes.push(camera === state.camera ? 'main' : camera === mirror ? 'reflection' : 'unexpected')
  }
  state.environmentAt = -Infinity
  state.render(performance.now())
  const gl = state.renderer.getContext(),
    width = gl.drawingBufferWidth,
    height = gl.drawingBufferHeight
  const read = () => {
    const data = new Uint8Array(width * height * 4)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data)
    return data
  }
  const withStars = read()
  const original = state.skyMaterial.fragmentShader
  state.skyMaterial.fragmentShader = original.replace(
    'color += stellarRadiance(direction, moonAngle) * stellarWindow;',
    'color += vec3(0.0);',
  )
  state.skyMaterial.needsUpdate = true
  state.render(performance.now())
  const withoutStars = read()
  let skyDifference = 0,
    lowDifference = 0
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const difference =
        Math.abs(withStars[i]! - withoutStars[i]!) +
        Math.abs(withStars[i + 1]! - withoutStars[i + 1]!) +
        Math.abs(withStars[i + 2]! - withoutStars[i + 2]!)
      if (y > height * 0.55) skyDifference += difference
      else if (y > height * 0.4 && y < height * 0.46) lowDifference += difference
    }
  state.skyMaterial.fragmentShader = original
  state.skyMaterial.needsUpdate = true
  state.render(performance.now())
  return { count: leaf.count, passes, skyDifference, lowDifference }
}

export function leafContacts() {
  const state = engine as unknown as {
    camera: PerspectiveCamera
    details: import('../src/scene/scene-details').SceneDetails
    water: import('../src/scene/lake-water').LakeReflector
  }
  const leaves = state.details.leaves
  const uniforms = (leaves as unknown as { uniforms: Record<string, { value: unknown }> }).uniforms
  return {
    sharedTexture: uniforms.uState === state.water.material.uniforms.uState,
    contacts: leaves.drift.leaves.map((leaf) => {
      const p = new Vector3(leaf.x, 0, leaf.z).project(state.camera)
      return {
        x: ((p.x + 1) * innerWidth) / 2,
        y: ((1 - p.y) * innerHeight) / 2,
        worldX: leaf.x,
        worldZ: leaf.z,
      }
    }),
  }
}

export function meteorProbe() {
  const state = engine as unknown as {
    camera: PerspectiveCamera
    shootingStars: import('../src/scene/stars').ShootingStars
    skyMaterial: ShaderMaterial
    options: { reducedMotion: boolean }
    lastFrameAt: number
    cancelFrame(): void
    render(now: number): void
  }
  state.cancelFrame()
  state.shootingStars.remaining = 0
  state.shootingStars.advance(0, -0.5, false, false, state.camera)
  state.shootingStars.age = 0.4
  state.options.reducedMotion = false
  state.lastFrameAt = performance.now()
  state.render(state.lastFrameAt)
  state.cancelFrame()
  return {
    age: state.skyMaterial.uniforms.uMeteorAge!.value,
    attempts: state.shootingStars.attempts,
  }
}

/** Close inspection of the actual material and its water contact, not a separate demo. */
export function leafCloseup() {
  const state = engine as unknown as {
    camera: PerspectiveCamera
    details: import('../src/scene/scene-details').SceneDetails
    options: { reducedMotion: boolean }
    cancelFrame(): void
    render(now: number): void
  }
  state.cancelFrame()
  state.options.reducedMotion = true
  const leaf = state.details.leaves.drift.leaves[1]!
  const update = state.camera.updateMatrixWorld.bind(state.camera)
  state.camera.updateMatrixWorld = (force) => {
    state.camera.position.set(leaf.x + 0.4, 1.1, leaf.z + 1.1)
    state.camera.lookAt(leaf.x, 0, leaf.z)
    update(force)
  }
  state.render(performance.now())
  state.camera.updateMatrixWorld = update
}
