import { shadow } from 'three/tsl'
import { BackSide, PointLight, Vector3 } from 'three/webgpu'
import type {
  Camera,
  DirectionalLight,
  Object3D,
  PerspectiveCamera,
  RenderTarget,
  Scene,
  WebGPURenderer,
} from 'three/webgpu'

import { compileWithoutCulling } from './compile-scene'
import type { DepthFocus } from './depth-focus'
import type { EnvironmentProbe } from './environment-probe'
import type { LakeReflector } from './lake-water'
import type { LightingState } from './lighting'
import type { RainEffect } from './rain-effect'
import type { SceneContrast } from './scene-contrast'
import type { SceneDetails } from './scene-details'
import type { SeasonalFauna } from './seasonal-fauna'
import type { SkyAtmosphere } from './sky-atmosphere'
import type { SubmergedScene } from './submerged-scene'
import type { VolumetricClouds } from './volumetric-clouds'
import type { VolumetricLight } from './volumetric-light'
import type { WaterSimulation } from './water-simulation'

/** Resolves on the next animation frame, so the loader presents between preparation steps. */
export function preparationFrame(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => {
      cancelAnimationFrame(frame)
      reject(new DOMException('Scene preparation cancelled', 'AbortError'))
    }
    const frame = requestAnimationFrame(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    })
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Records the renderer's program count at a compile stage, for the benchmark. */
export function snapshotPrograms(renderer: WebGPURenderer, stage: string) {
  performance.measure(`programs:${stage}:${renderer.info.memory.programs}`)
}

/** Everything the compile sequence renders or toggles; the engine owns all of it. */
export type CompileTargets = Readonly<{
  renderer: WebGPURenderer
  scene: Scene
  camera: PerspectiveCamera
  water: LakeReflector
  /** The sky dome alone, for the lake's sky reflection. */
  reflectedSky: Scene
  depthFocus: DepthFocus
  atmosphere: VolumetricLight
  skyAtmosphere: SkyAtmosphere
  clouds: VolumetricClouds
  rain: RainEffect
  sceneContrast: SceneContrast
  simulation: WaterSimulation
  submerged: SubmergedScene
  fauna: SeasonalFauna
  details: SceneDetails | undefined
  probe: EnvironmentProbe
  moon: DirectionalLight
  lampLights: readonly PointLight[]
  /** Static terrain shadow casters (layer 5). */
  shadowGroup: Object3D
  /** The forest, which casts its own shadows; null when it failed to load. */
  vegetation: Object3D | null
  /** Hidden until a gust, flight or gesture shows them; every view compiles them up front. */
  transient: readonly Object3D[]
  /** The mirror's layers: see the engine's `setReflectionLayers`. */
  setReflectionLayers: (camera: Camera) => void
  weatherMayChange: boolean | undefined
}>

/** Clouds, sky, rain, contrast, water simulation and waterfall fluid, one after another. */
export async function compilePasses(targets: CompileTargets, light: LightingState) {
  const { renderer, camera, details } = targets
  await targets.clouds.compileAsync(targets.weatherMayChange)
  await targets.skyAtmosphere.compileAsync()
  targets.skyAtmosphere.update(light.sunDirection, light.skyExposure)
  const compileRain = () =>
    targets.rain.compileAsync(renderer, camera, targets.weatherMayChange, targets.scene)
  await (details ? details.compileAsync(compileRain) : compileRain())
  await targets.sceneContrast.compileAsync(renderer)
  await targets.simulation.compileAsync()
  await details?.prepareFluid(renderer, camera)
}

/** Capture render state synchronously: the loader borrows this renderer between yields. */
function compileView(
  targets: CompileTargets,
  camera: Camera,
  target: RenderTarget | null,
  object: Object3D = targets.scene,
  face = 0,
  withDetails = true,
) {
  const { renderer, scene, details } = targets
  const previous = renderer.getRenderTarget()
  const previousFace = renderer.getActiveCubeFace(),
    mip = renderer.getActiveMipmapLevel()
  try {
    renderer.setRenderTarget(target, face)
    const compile = () => renderer.compileAsync(object, camera, scene)
    return withDetails && details ? details.compileAsync(compile) : compile()
  } finally {
    renderer.setRenderTarget(previous, previousFace, mip)
  }
}

function compileShadowMaps(
  targets: CompileTargets,
  issue: (compile: () => Promise<unknown>) => void,
  casters: Object3D,
) {
  const { scene } = targets
  for (const light of [targets.moon, ...targets.lampLights]) {
    const map = light.shadow.map
    if (!map) continue
    if (light instanceof PointLight) {
      // Point lights have no target; their shadow node orients each cube face.
      const camera = light.shadow.camera
      camera.position.setFromMatrixPosition(light.matrixWorld)
      camera.up.set(0, -1, 0)
      camera.lookAt(camera.position.clone().add(new Vector3(-1, 0, 0)))
      camera.far = light.distance || camera.far
      camera.updateProjectionMatrix()
      camera.updateMatrixWorld()
    } else light.shadow.updateMatrices(light)
    issue(() => {
      const material = scene.overrideMaterial,
        background = scene.background
      try {
        const shadowMaterial = shadow(light).getShadowMaterial()
        // Shadow rendering flips front-sided casters. Keep that same variant while
        // compileAsync yields, rather than restoring its default front side.
        shadowMaterial.side = BackSide
        scene.overrideMaterial = shadowMaterial
        scene.background = null
        return compileView(targets, light.shadow.camera, map, casters)
      } finally {
        scene.overrideMaterial = material
        scene.background = background
      }
    })
  }
}

/**
 * Compiles the environment probe, the shadow maps and every remaining scene
 * pass once the already issued offscreen `passes` have settled. Three's
 * `compileAsync` keeps one precompilation state on the renderer, so calls run
 * one at a time: overlapping calls that share a node build in flight swap each
 * other's render state. Each call still compiles its pipelines in parallel
 * while it builds the next node graphs.
 */
export async function compileScene(
  targets: CompileTargets,
  signal: AbortSignal,
  passes: Promise<unknown>,
) {
  const { renderer, scene, camera, water, depthFocus, details, probe } = targets
  await passes
  signal.throwIfAborted()
  // Establish the final environment texture before building any lit material variant.
  await probe.prepare(() => preparationFrame(signal))
  snapshotPrograms(renderer, 'environment')

  // Each task sets up its renderer and scene state when it runs, not when it is issued.
  const tasks: (() => Promise<unknown>)[] = []
  const issue = (compile: () => Promise<unknown>) => tasks.push(compile)

  // The probe's own traversal, with the planar water and the detail layer out:
  // those materials are invisible in the cube so compiling them would only mint
  // variants the probe never draws.
  performance.mark('compile:scene')
  const cubeCamera = probe.faceCamera
  const compileProbe = () => compileView(targets, cubeCamera, probe.target, scene, 0, false)
  issue(() => {
    water.visible = false
    try {
      // All six faces use the same lighting, layers and attachment formats. Include
      // off-axis meshes once instead of compiling their cached variants on every face.
      return compileWithoutCulling(scene, () =>
        details ? details.probeHidden(compileProbe) : compileProbe(),
      )
    } finally {
      water.visible = true
    }
  })

  compileShadowMaps(targets, issue, targets.shadowGroup)
  // The forest casts its own shadows; every other view reaches it through the scene.
  if (targets.vegetation) compileShadowMaps(targets, issue, targets.vegetation)

  issue(() => targets.submerged.compileAsync(renderer, scene, camera))
  // Bats and insects are hidden until their hour; their programs still compile here.
  issue(() => targets.fauna.compileVisible(() => compileView(targets, camera, depthFocus.target)))
  issue(() => targets.atmosphere.compileAsync(depthFocus.target, camera, targets.moon))
  issue(() => depthFocus.compileAsync(renderer, camera))
  issue(() => water.compileSky(renderer, targets.reflectedSky))
  // Falling leaves, the flock, the stone, the wave ring and the lanterns are hidden until a
  // gust, a flight or a gesture (an autumn wood sheds within seconds, the demonstration stone
  // flies after seven): every view that may draw them compiles their programs now.
  const transient = targets.transient.map((object) => [object, object.visible] as const)
  for (const [object] of transient) object.visible = true
  for (const task of tasks) {
    // eslint-disable-next-line no-await-in-loop -- one compileAsync at a time, see above
    await task()
    signal.throwIfAborted()
  }

  const reflected = water.getReflectionCamera(camera)
  reflected.copy(camera)
  targets.setReflectionLayers(reflected)
  // The mirror renders at the main view's depth and attachments, so it shares
  // that render context: once the view's builds have settled, this only adds
  // objects outside the main frustum and the mirrored pipelines.
  water.visible = false
  let mirror: Promise<unknown>
  try {
    mirror = compileView(targets, reflected, water.getRenderTarget(reflected))
  } finally {
    water.visible = true
  }
  await mirror
  for (const [object, visible] of transient) object.visible = visible
  snapshotPrograms(renderer, 'scene')
  signal.throwIfAborted()

  targets.moon.shadow.needsUpdate = true
  for (const light of targets.lampLights) light.shadow.needsUpdate = true
  probe.captureAll()
  probe.captureSky()
  await preparationFrame(signal)
}

/**
 * A real offscreen pass also prepares nested render contexts (the fluid capture inside the main
 * view). No simulation step runs and the shared canvas continues to contain the loader.
 */
export function warmupScene(targets: CompileTargets) {
  const { renderer, scene, camera, water, depthFocus, details } = targets
  const target = renderer.getRenderTarget(),
    face = renderer.getActiveCubeFace(),
    mip = renderer.getActiveMipmapLevel()
  try {
    const render = () => {
      water.renderReflection(renderer, scene, camera)
      renderer.setRenderTarget(depthFocus.target)
      renderer.render(scene, camera)
    }
    if (details) details.warmup(render)
    else render()
    depthFocus.warmup(renderer)
  } finally {
    renderer.setRenderTarget(target, face, mip)
  }
}
