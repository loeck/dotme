import { exp, shadow, uniform, uv, vec4 } from 'three/tsl'
import {
  AmbientLight,
  BackSide,
  BoxGeometry,
  Camera,
  BufferAttribute,
  BufferGeometry,
  Color,
  CubeCamera,
  DirectionalLight,
  DoubleSide,
  FogExp2,
  Group,
  HalfFloatType,
  InstancedMesh,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  Object3D,
  PCFShadowMap,
  PMREMGenerator,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  PointLight,
  Raycaster,
  ACESFilmicToneMapping,
  SRGBColorSpace,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  CubeRenderTarget,
  WebGPURenderer,
} from 'three/webgpu'
import type { RenderTarget } from 'three/webgpu'

import type { AmbientEnvironment } from '../audio/environment'
import { pointSound, waterfallSound } from '../audio/environment'
import type { WaterSoundEvent } from '../audio/water-sounds'
import { sceneParams } from '../scene-params'
import { BirdFlock, FLOCK } from './bird-flock'
import { CAMERA_IDLE_DRIFT, CAMERA_REST, cameraTarget, ENVIRONMENT_PROBE } from './camera-rig'
import { installCompilationScheduler } from './compilation-scheduler'
import { compileWithoutCulling } from './compile-scene'
import { sampleWaterfallHit, seesWorld, WATERFALL_OCCLUSION_TOLERANCE } from './cursor-world'
import { DepthFocus } from './depth-focus'
import { LOW_POWER_FPS, isLowPowerDevice, maxPixelRatio } from './device-profile'
import { DeviceTilt } from './device-tilt'
import { SceneRenderDiagnostics } from './diagnostics'
import type { SceneElimination, SceneGpuInfo } from './diagnostics'
import { FallingLeaves, LEAVES } from './falling-leaves'
import type { FishBait } from './fish-pointer'
import { GLOW_BLENDING } from './glow-blending'
import { LAKE_BOUNDS, WATER_LEVEL, lakeIndex } from './lake-bed'
import type { LakeBed } from './lake-bed'
import { FISH_LAYER } from './lake-fish'
import { LakeLanterns, isDoubleTap } from './lake-lanterns'
import { createLakeReflector } from './lake-water'
import type { LakeReflector } from './lake-water'
import type { LakeLamp, WaterfallSite } from './lake-world'
import { flareStrength } from './lens-flare'
import { fadeNightLight, mistFactor, sampleLighting } from './lighting'
import type { LightingState } from './lighting'
import { LIGHTNING, Lightning } from './lightning'
import type { Strike } from './lightning'
import { createPhysicsWorld, loadPhysics } from './physics-world'
import type { PhysicsWorld } from './physics-world'
import { PointerLight } from './pointer-light'
import type { PointerLightResponse } from './pointer-light'
import { prepareWorldAsync } from './prepare-world'
import type { PreparedWorld } from './prepare-world'
import { DEFAULT_RAIN, UMBRELLA_RADIUS } from './rain-simulation'
import type { RainState } from './rain-simulation'
import { RainEffect } from './RainEffect'
import { ResourceScope } from './resource-scope'
import { SceneContrast } from './scene-contrast'
import { SceneDetails } from './scene-details'
import type { DetailEnvironment } from './scene-details'
import { SceneGrade } from './scene-grade'
import { sampleLook } from './scene-look'
import { SkyAtmosphere } from './sky-atmosphere'
import { createSkyMaterial, updateSkyLighting } from './sky-material'
import { DEFAULT_SOLAR, SolarClock, introGap, parseInitialTime, wrapDay } from './solar-clock'
import type { SolarEndpoints } from './solar-clock'
import { SPLASH_IMPACT_LAYER } from './splash-impacts'
import { stableShadowFilter } from './stable-shadow'
import { ShootingStars } from './stars'
import { SKIP, SkippingStone, flickOrigin, planSkips } from './stone-skips'
import type { FlickSample } from './stone-skips'
import { SubmergedScene } from './submerged-scene'
import { TerrainSkyFill } from './terrain-detail'
import { createBoulderMaterial, createTerrainMaterial } from './terrain-material'
import { loadTerrainTextures } from './terrain-textures'
import type { TerrainTextures } from './terrain-textures'
import { SCRUB, TimeScrub, wheelPixels } from './time-scrub'
import { UNDERGROWTH_LAYER, Vegetation } from './vegetation'
import { VolumetricClouds } from './volumetric-clouds'
import { VolumetricLight } from './volumetric-light'
import { sampleWaterOptics } from './water-optics'
import { waterStroke } from './water-pointer'
import { WaterShockwave, shockImpulse } from './water-shockwave'
import { WaterSimulation } from './water-simulation'
import { createWaterGeometry } from './water-surface'
import { WATERFALL_FLUID_LAYER, WATERFALL_REFLECTION_LAYER } from './waterfall-fluid'
import { WEATHER } from './weather'
import type { WeatherPreset } from './weather'
import { WindModel, updateWindUniforms } from './wind'
import type { WindState } from './wind'
import type { WindOptions } from './wind'
import { sweepStrength } from './wind-gusts'
import { createWindUniforms } from './wind-nodes'
import type { VegetationPart } from './world-data'

/** A long press on the water released as a wave, placed in the view. */
export type ShockwaveEvent = Readonly<{
  /** 0–1: how long the press was held. */
  charge: number
  /** 0–1 after distance attenuation. */
  intensity: number
  /** -1 (left) to 1 (right). */
  pan: number
  pointerType: string
}>

export type StoneTouchdownEvent = Readonly<{
  /** 0 where the stone lands, then one per skip. */
  index: number
  /** The last touchdown, where the stone sinks. */
  sinking: boolean
  /** Splash energy in [0, 1]. */
  energy: number
  /** 0–1 after distance attenuation. */
  intensity: number
  /** -1 (left) to 1 (right). */
  pan: number
  /** Pointer type of the throw, or `demo` for the scene's own. */
  pointerType: string
}>

export type VoxelLandscapeEngineOptions = Readonly<{
  container: HTMLDivElement
  renderer: WebGPURenderer
  onContextFailure: () => void
  onFirstFrame: () => void
  onEnvironment?: (state: AmbientEnvironment) => void
  /** Splashes, breaking waves and drops, attenuated by distance and placed in stereo. */
  onWaterSound?: (event: WaterSoundEvent) => void
  /** Each touchdown of a thrown stone, placed in the view, for its note and haptics. */
  onStoneTouchdown?: (event: StoneTouchdownEvent) => void
  /** A long press on the water released as a wave, for its note and haptics. */
  onShockwave?: (event: ShockwaveEvent) => void
  /** Each lightning strike's thunder, to be played when its sound arrives. */
  onThunder?: (event: Strike) => void
  /** A thunderstorm is reported: lightning whatever the rain (heavy rain brings it too). */
  storm?: boolean
  reducedMotion?: boolean
  seed?: number
  /** Disable only the optional detail layer for controlled visual/performance comparisons. */
  sceneDetails?: boolean
  detailEnvironment?: Partial<DetailEnvironment>
  prepared?: PreparedWorld
  rain?: RainState
  weather?: WeatherPreset
  wind?: WindOptions
  solar?: SolarEndpoints
  nowSeconds?: number
}>

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const smooth = (a: number, b: number, value: number) => {
  const t = clamp((value - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

const COMPILE_STAGES = ['passes', 'environment', 'scene', 'warmup'] as const
/** Seconds after the first frame before an untouched scene skips a stone by itself. */
const DEMO_DELAY = 7
/** Seconds a cursor must rest at night before the fireflies come to it. */
const FIREFLY_GATHER_DELAY = 1.2
/** Seconds between the faint ripples a charging press draws on the water. */
const SHOCK_RIPPLE = 0.3
/** Seconds into a visit before the first flock crosses the sky, then between flocks. */
const FLOCK_FIRST = 22
const FLOCK_GAP = [55, 95] as const
/** Screen points, as shares of the canvas, where the demonstration stone may land. */
const DEMO_LANDINGS = [
  [0.5, 0.74],
  [0.42, 0.7],
  [0.58, 0.7],
  [0.5, 0.82],
] as const

function preparationFrame(signal: AbortSignal): Promise<void> {
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

type Mote = Readonly<{
  x: number
  y: number
  z: number
  size: number
  phase: number
  speed: number
}>

const DOWN = new Vector3(0, -1, 0)

/** Nearest entry of a ray (unit direction) into any sphere (x, y, z, radius), before `max`. */
function raySpheres(
  origin: Vector3,
  direction: Vector3,
  spheres: Float32Array,
  max: number,
): number {
  let nearest = max
  for (let i = 0; i + 3 < spheres.length; i += 4) {
    const ox = origin.x - (spheres[i] ?? 0),
      oy = origin.y - (spheres[i + 1] ?? 0),
      oz = origin.z - (spheres[i + 2] ?? 0)
    const r = spheres[i + 3] ?? 0
    const b = ox * direction.x + oy * direction.y + oz * direction.z
    const c = ox * ox + oy * oy + oz * oz - r * r
    const disc = b * b - c
    if (disc < 0) continue
    const t = -b - Math.sqrt(disc)
    if (t > 0 && t < nearest) nearest = t
  }
  return nearest
}

export class VoxelLandscapeEngine {
  private readonly renderDiagnostics = new SceneRenderDiagnostics()
  private readonly options: Omit<VoxelLandscapeEngineOptions, 'prepared'>
  private readonly container: HTMLDivElement
  private readonly renderer: WebGPURenderer
  private readonly depthFocus: DepthFocus
  private readonly atmosphere: VolumetricLight
  private readonly skyAtmosphere: SkyAtmosphere
  private readonly sceneContrast: SceneContrast
  private readonly grade = new SceneGrade()
  private gradeFrame = 0
  private readonly waterfall: WaterfallSite | undefined
  private readonly waterfallAudioPosition = new Vector3()
  private readonly soundPosition = new Vector3()
  private solarClock: SolarClock
  private readonly solar: SolarEndpoints
  private reducedMotion: boolean
  private nightLightFade = 0
  private readonly weather
  private readonly showSun: boolean
  private readonly ambient = new AmbientLight()
  private readonly terrainSky = new TerrainSkyFill()
  private readonly baseFogDensity = 0.0105
  private readonly fog = new FogExp2(0x14202a, this.baseFogDensity)
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(54, 1, 0.05, 500)
  private readonly raycaster = new Raycaster()
  private readonly rayNdc = new Vector2()
  private readonly waterPlane = new Plane(new Vector3(0, 1, 0), -WATER_LEVEL)
  private readonly waterHit = new Vector3()
  private readonly grabPlane = new Plane()
  private readonly grabNormal = new Vector3()
  private readonly grabPoint = new Vector3()
  private grabPointerId = -1
  // Separate targets: processPointer() runs inside render() and must not overwrite the
  // frame's water point, nor a stroke's endpoints while it samples between them.
  private readonly frameWaterPoint = new Vector3()
  private readonly pressPoint = new Vector3()
  private readonly strokeStart = new Vector3()
  private readonly strokeEnd = new Vector3()
  private readonly strokeSample = new Vector3()
  private readonly strokeContact = new Vector3()
  private readonly pointerLight = new PointerLight()
  private readonly lightHit = new Vector3()
  private readonly pointer = new Vector2(0, 0)
  private readonly pointerClient = new Vector2(-1, -1)
  private readonly detailPointerNdc = new Vector2()
  private readonly target = new Vector2(0, 0)
  private readonly tilt = new DeviceTilt()
  private readonly moonShadowDirection = new Vector3(Number.NaN, Number.NaN, Number.NaN)
  private readonly shadowProbe = new Vector3()
  private lampShadowCursor = 0
  private readonly waterPointerTarget = new Vector3(0, 0, 0)
  private readonly objects: Object3D[] = []
  private readonly materials: Array<{ dispose: () => void }> = []
  private readonly geometries: Array<{ dispose: () => void }> = []
  private readonly lampLights: Array<{
    source: LakeLamp
    light: PointLight
    bulb: Mesh<SphereGeometry, MeshBasicNodeMaterial>
    glow: Mesh<PlaneGeometry, MeshBasicNodeMaterial>
    color: Color
    glowStrength: { value: number }
    /** Light position the current cube map was rendered from. */
    shadowPosition: Vector3
  }> = []
  private readonly motes: Mote[] = []
  private moteMesh: InstancedMesh<BoxGeometry, MeshBasicNodeMaterial> | null = null
  private vegetation: Vegetation | undefined
  /** Trees' and shrubs' picking spheres (x, y, z, radius), empty until the forest loads. */
  private vegetationPick: Float32Array = new Float32Array(0)
  /** Holds the forest, built before the first frame. */
  private readonly vegetationGroup = new Group()
  private readonly moteTransform = new Object3D()
  private readonly moon = new DirectionalLight(0xa3bfd6, 1.5)
  private readonly environmentTarget: CubeRenderTarget
  private readonly environmentCamera: CubeCamera
  private readonly environmentFilter: PMREMGenerator
  private filteredEnvironment: CubeRenderTarget | undefined
  private readonly drawingBufferSize = new Vector2()
  private readonly water: LakeReflector
  private readonly simulation: WaterSimulation
  private readonly submerged: SubmergedScene
  private readonly bed: LakeBed
  private details: SceneDetails | undefined
  private detailEnvironment: Partial<DetailEnvironment> = {}
  private readonly physics: PhysicsWorld
  private readonly lightingHost: HTMLElement | null
  private canvasBounds: DOMRect | null = null
  private pointerActive = false
  private pointerType = 'mouse'
  private primaryMouseDown = false
  private skyPointerId = -1
  private pointerHeight = 0
  private pointerRevision = 0
  private pointerBusy = false
  private pendingPointer: { x: number; y: number; time: number } | null = null
  private previousPointer: { x: number; y: number; time: number } | null = null
  private readonly blockPoint = new Vector2(0, 0)
  private blockStrength = 0
  private readonly umbrella = { x: 0, y: 0, z: 0, radius: UMBRELLA_RADIUS }
  private bait: { x: number; z: number; born: number } | null = null
  private readonly stone = new SkippingStone(WATER_LEVEL)
  /** Recent screen positions of the dragging pointer, to read a flick's speed at release. */
  private readonly flick: FlickSample[] = []
  private readonly flickStart = new Vector3()
  private readonly flickEnd = new Vector3()
  private readonly stoneHand = new Vector3()
  private stoneThrower = 'mouse'
  /** True once the visitor has pressed the scene; until then a demonstration stone is due. */
  private interacted = false
  private demoThrown = false
  /** The visitor's run through the day with the wheel or two fingers, over the real clock. */
  private readonly scrub = new TimeScrub()
  private readonly birds: BirdFlock
  private readonly leaves: FallingLeaves
  private readonly leafRayOrigin = new Vector3()
  private readonly seed: number
  /** Daylight of the last frame, for gestures between frames. */
  private daylight = 0
  private nextFlockAt = FLOCK_FIRST
  private readonly shockwave = new WaterShockwave(WATER_LEVEL)
  /** When the mouse last moved or pressed, in ms: a still cursor gathers the fireflies. */
  private pointerStillSince = 0
  private readonly gatherPoint = new Vector3()
  private readonly flarePoint = new Vector3()
  /** The pointer's client position last frame, for the screen speed of a sweep. */
  private readonly sweepClient = new Vector2(Number.NaN, Number.NaN)
  private readonly sweepFrom = new Vector3()
  private readonly sweepTo = new Vector3()
  private readonly waterHitScratch = new Vector3()
  private readonly lanterns = new LakeLanterns()
  /** The last tap on the water that threw nothing, for a double tap to set a lantern afloat. */
  private lastTap: { x: number; y: number; time: number } | null = null
  private readonly lanternPoint = new Vector3()
  private flareLevel = 0
  private nextShockRipple = 0
  private readonly lightning = new Lightning()
  private flockCount = 0
  private readonly flockStart = new Vector3()
  /** Vertical positions of the touches on the scene, for the two-finger time scrub. */
  private readonly touches = new Map<number, number>()
  private readonly wind: WindModel
  private readonly windUniforms = createWindUniforms()
  private readonly clouds: VolumetricClouds
  private readonly rain: RainEffect
  private readonly shootingStars: ShootingStars
  private starTime = 0
  private ambientStateAt = -Infinity
  private readonly skyMaterial: ReturnType<typeof createSkyMaterial>
  private readonly sky: Mesh<SphereGeometry, ReturnType<typeof createSkyMaterial>>
  /** The sky dome alone, captured every frame for the lake's sky reflection. */
  private readonly reflectedSky = new Scene()
  private readonly voxelGroup = new Group()
  private readonly shadowGroup = new Group()
  private frame = 0
  /** Starts at one so the first presented frame renders the lakebed capture. */
  private submergedFrame = 1
  private frameTimer = 0
  private nextFrameAt = 0
  private focused = document.hasFocus()
  private environmentAt = -Infinity
  private environmentTime = -Infinity
  private environmentFace = 6
  private lastFrameAt = 0
  private elapsed = 0
  private intro = 0
  private introStartedAt: number | null = null
  private dragging = false
  private dragPointerId = -1
  private disposed = false
  private rendered = false
  private initialized = false
  private width = 1
  private height = 1
  private mobile = false
  private lowPower = false

  static async create(options: VoxelLandscapeEngineOptions, signal: AbortSignal) {
    const physicsModule = loadPhysics()
    const prepared =
      options.prepared ??
      (await prepareWorldAsync((options.seed ?? 0) >>> 0, window.innerWidth < 768, signal))
    signal.throwIfAborted()
    const resources = new ResourceScope()
    for (const stage of COMPILE_STAGES) performance.clearMarks(`compile:${stage}`)
    performance.clearMeasures()
    const releaseCompilationScheduler = installCompilationScheduler()
    let engine: VoxelLandscapeEngine | undefined
    let passes: Promise<unknown> | undefined
    const abort = () => {
      engine?.dispose()
      resources.dispose()
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const terrainTextures = loadTerrainTextures(
        resources,
        Math.min(window.innerWidth < 768 ? 4 : 8, options.renderer.getMaxAnisotropy()),
      )
      // Let the loader present between CPU preparation and material compilation.
      await preparationFrame(signal)
      signal.throwIfAborted()
      // Owned before the next yield so cancellation also frees the Rapier world.
      const physics = resources.own(createPhysicsWorld(await physicsModule, prepared.colliders))
      // Collider creation and scene construction are separate tasks for the loader.
      await preparationFrame(signal)
      const scans = await terrainTextures
      signal.throwIfAborted()
      engine = new VoxelLandscapeEngine({ ...options, prepared, physics }, resources, scans)
      const initialLight = sampleLighting(
        engine.solarClock.seconds(0),
        0,
        engine.weather,
        engine.solar,
      )
      engine.applyLighting(initialLight)
      engine.nightLightFade = initialLight.localLightStrength
      // The offscreen passes do not depend on the lit scene: issue them before
      // the environment so their pipelines compile alongside the scene batch.
      performance.mark('compile:passes')
      passes = engine.compilePasses(options.renderer, initialLight)
      // Settled with the scene batch; keep an early failure from going unhandled.
      passes.catch(() => undefined)
      // The forest is part of the first frame: wait for the worker's vegetation and add it
      // before the scene compiles, so trees never pop in after the loader has gone.
      await engine.addVegetation(prepared.vegetation, signal)
      performance.mark('compile:environment')
      await engine.compileScene(signal, options.renderer, passes)
      performance.mark('compile:warmup')
      engine.warmupScene()
      engine.snapshotPrograms('warmup')
      await preparationFrame(signal)
      signal.throwIfAborted()
      engine.publishDiagnostics()
      engine.initialized = true
      engine.lastFrameAt = performance.now()
      engine.requestFrame()
      return engine
    } catch (error) {
      // Offscreen compiles may still run; let them settle before their owners are disposed.
      await passes?.catch(() => undefined)
      engine?.dispose()
      resources.dispose()
      throw error
    } finally {
      releaseCompilationScheduler()
      signal.removeEventListener('abort', abort)
    }
  }

  private readonly resources: ResourceScope
  private readonly terrainTextures: TerrainTextures | undefined

  private constructor(
    options: VoxelLandscapeEngineOptions & { prepared: PreparedWorld; physics: PhysicsWorld },
    resources: ResourceScope,
    terrainTextures: TerrainTextures | undefined,
  ) {
    this.resources = resources
    this.terrainTextures = terrainTextures
    const { prepared, physics, ...configuration } = options
    this.options = configuration
    // `create` already owns the physics world in this scope.
    this.physics = physics
    this.reducedMotion = options.reducedMotion ?? false
    this.bed = options.prepared.world.lakeBed
    this.waterfall =
      options.sceneDetails === false ? undefined : (options.prepared.world.waterfall ?? undefined)
    this.detailEnvironment = { ...options.detailEnvironment }
    this.container = options.container
    this.lightingHost = options.container.closest('main')
    this.sceneContrast = this.resources.own(
      new SceneContrast(
        this.container.closest('main'),
        () => {
          if (this.reducedMotion) this.requestFrame()
        },
        this.grade,
      ),
    )
    this.mobile = options.prepared
      ? options.prepared.world.variant === 'mobile'
      : window.innerWidth < 768
    this.lowPower = this.mobile || isLowPowerDevice()
    const params = sceneParams(window.location.search)
    this.solar = options.solar ?? DEFAULT_SOLAR
    const initialSeconds = params.startTime
      ? parseInitialTime(params.startTime)
      : (options.nowSeconds ?? parseInitialTime(null))
    // An explicit start time is a request for that light: only the default opens on a golden hour.
    this.solarClock = new SolarClock(
      initialSeconds,
      options.reducedMotion,
      performance.now(),
      params.timeScale,
      params.startTime ? 0 : introGap(initialSeconds, this.solar),
    )
    this.weather = options.weather ?? 'partly-cloudy'
    this.showSun = true
    this.renderer = options.renderer
    this.renderer.setClearColor(0x080c11)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = PCFShadowMap
    // Update once per animation frame; all reflection cameras reuse these shadows.
    this.environmentTarget = this.resources.own(
      new CubeRenderTarget(this.lowPower ? 64 : 256, {
        type: HalfFloatType,
      }),
    )
    this.environmentFilter = this.resources.own(new PMREMGenerator(this.renderer))
    this.environmentTarget.texture.name = 'Live landscape environment'
    this.environmentCamera = new CubeCamera(0.1, 500, this.environmentTarget)
    this.environmentCamera.position.set(
      ENVIRONMENT_PROBE.x,
      ENVIRONMENT_PROBE.y,
      ENVIRONMENT_PROBE.z,
    )
    this.depthFocus = this.resources.own(new DepthFocus(this.renderer, this.lowPower, this.grade))
    this.renderer.outputColorSpace = SRGBColorSpace
    this.renderer.toneMapping = ACESFilmicToneMapping
    this.renderer.domElement.className = 'block h-full w-full touch-none'
    this.seed = (options.seed ?? 0) >>> 0
    this.renderer.domElement.dataset.seed = String(this.seed)
    this.renderer.domElement.dataset.weather = this.weather
    this.renderer.domElement.dataset.generatorVersion = 'voxel-landscape-v1'
    this.scene.fog = this.fog
    this.scene.background = new Color(0x080c11)
    this.scene.add(this.ambient)
    this.moon.position.set(-35, 48, -48)
    this.moon.target.position.set(0, 0, -28)
    this.moon.castShadow = true
    this.moon.shadow.autoUpdate = false
    this.resources.own(this.moon.shadow)
    this.moon.shadow.camera.layers.set(5)
    this.moon.shadow.mapSize.setScalar(this.lowPower ? 1024 : 2048)
    Object.assign(this.moon.shadow.camera, {
      left: -260,
      right: 260,
      top: 260,
      bottom: -260,
      near: 0.5,
      far: 640,
    })
    this.moon.shadow.camera.updateProjectionMatrix()
    this.moon.shadow.normalBias = 0.12
    this.moon.shadow.bias = -0.00015
    // Anchored to the shadow map, so edges hold still while the view or the light moves.
    Object.assign(this.moon.shadow, {
      filterNode: stableShadowFilter(this.moon.shadow.mapSize.x, this.lowPower),
    })
    this.scene.add(this.moon, this.moon.target)

    this.wind = new WindModel((options.seed ?? 0) >>> 0, options.wind)
    this.clouds = this.resources.own(
      new VolumetricClouds(
        this.renderer,
        (options.seed ?? 0) >>> 0,
        this.mobile,
        this.wind,
        (time) => sampleLighting(this.solarClock.seconds(time), 0, this.weather, this.solar),
        this.weather,
        prepared.noise,
        this.lowPower,
      ),
    )
    this.clouds.shadows.applyToLight(this.moon)
    this.skyAtmosphere = this.resources.own(new SkyAtmosphere(this.renderer, this.lowPower))
    this.atmosphere = this.resources.own(
      new VolumetricLight(
        this.renderer,
        this.skyAtmosphere,
        this.lowPower,
        this.clouds.shadows.uniforms,
        WEATHER[this.weather].extinction,
      ),
    )
    this.shootingStars = new ShootingStars((options.seed ?? 0) >>> 0)
    this.skyMaterial = this.resources.own(
      createSkyMaterial((options.seed ?? 0) >>> 0, this.mobile, this.clouds, this.skyAtmosphere),
    )
    const skyGeometry = new SphereGeometry(260, 32, 16)
    this.sky = new Mesh(skyGeometry, this.skyMaterial)
    this.sky.frustumCulled = false
    this.scene.add(this.sky)
    const reflectedSky = new Mesh(skyGeometry, this.skyMaterial)
    reflectedSky.frustumCulled = false
    this.reflectedSky.add(reflectedSky)
    this.materials.push(this.skyMaterial)
    this.geometries.push(this.resources.own(skyGeometry))

    this.shadowGroup.visible = true
    this.scene.add(this.voxelGroup, this.shadowGroup)
    this.buildWorld(prepared)
    this.simulation = this.resources.own(
      new WaterSimulation(this.renderer, this.bed, this.mobile, this.wind, prepared.surfaces.mask),
    )
    this.camera.layers.disable(FISH_LAYER)
    this.camera.layers.enable(SPLASH_IMPACT_LAYER)
    this.camera.layers.enable(WATERFALL_FLUID_LAYER)
    this.camera.layers.enable(UNDERGROWTH_LAYER)
    this.submerged = this.resources.own(
      new SubmergedScene(
        this.scene,
        this.bed,
        this.simulation.available,
        prepared.surfaces.submerged,
        (options.seed ?? 0) >>> 0,
      ),
    )
    this.scene.traverse((object) => {
      if ('isLight' in object) {
        object.layers.enable(1)
        object.layers.enable(FISH_LAYER)
        object.layers.enable(SPLASH_IMPACT_LAYER)
      }
    })
    const cloudReceivers = new Set<MeshStandardNodeMaterial>()
    this.scene.traverse((object) => {
      if (object instanceof Mesh && object.material instanceof MeshStandardNodeMaterial)
        cloudReceivers.add(object.material)
    })
    for (const material of cloudReceivers) this.receiveSceneLight(material)
    this.details?.attachMaterials(
      this.voxelGroup,
      this.submerged.surfaceMaterials,
      this.submerged.sandMaterial,
    )
    const waterGeometry = createWaterGeometry(this.mobile, prepared.surfaces.water)
    this.water = this.resources.own(
      createLakeReflector(waterGeometry, this.lowPower, {
        wind: this.windUniforms,
        cloud: this.clouds.shadows.uniforms,
        pointer: this.pointerLight.uniforms,
      }),
    )
    const reflectedCamera = this.water.getReflectionCamera(this.camera)
    this.setReflectionLayers(reflectedCamera)
    const reflection = this.water.getRenderTarget(reflectedCamera).texture
    reflection.anisotropy = Math.min(this.lowPower ? 4 : 8, this.renderer.getMaxAnisotropy())
    reflection.name = 'Lake reflection'
    this.skyMaterial.uniforms.uReflectionCapture.onObjectUpdate(({ camera }) =>
      camera === reflectedCamera ? 1 : 0,
    )
    const uniforms = this.water.material.uniforms
    uniforms.uState.value = this.simulation.texture
    uniforms.uMask.value = this.simulation.mask
    uniforms.uCell.value = LAKE_BOUNDS.size / this.simulation.resolution
    uniforms.uBedColor.value = this.submerged.target.texture
    const bedDepth = this.submerged.target.depthTexture
    if (!bedDepth) throw new Error('Missing lake depth texture')
    uniforms.uBedDepth.value = bedDepth
    uniforms.uBedAtlas.value = this.submerged.atlasLayout
    uniforms.uFishInverseViewProjection.value = this.submerged.fishInverseViewProjection
    uniforms.uBedHeight.value = this.submerged.depthField
    uniforms.uBedFieldLayout.value = this.submerged.fieldLayout
    this.details?.setWaterImpact(
      (x, z, radius, velocity) => this.simulation.addImpulse(x, z, radius, velocity),
      uniforms,
      this.simulation.contact,
    )
    this.renderer.domElement.dataset.waterMode = this.simulation.available ? 'gpu' : 'analytic'
    this.water.rotation.x = -Math.PI / 2
    this.water.position.y = WATER_LEVEL
    this.water.updateMatrixWorld(true)
    this.water.matrixAutoUpdate = this.water.matrixWorldAutoUpdate = false
    this.water.receiveShadow = true
    this.scene.add(this.water)
    this.objects.push(this.water)
    this.scene.add(this.stone.mesh)
    this.scene.add(this.shockwave.mesh)
    this.scene.add(this.lanterns.mesh)
    this.birds = new BirdFlock(this.lowPower ? FLOCK.lowPowerSize : FLOCK.size)
    this.scene.add(this.birds.group)
    this.leaves = new FallingLeaves(
      this.mobile ? LEAVES.mobileCapacity : LEAVES.capacity,
      this.camera.position,
      (x, z, fromY) => this.leafGround(x, z, fromY),
      (x, z) => this.simulation.addImpulse(x, z, 0.14, -0.05),
    )
    this.scene.add(this.leaves.mesh)
    this.receiveSceneLight(this.leaves.mesh.material, { translucency: 0.6, gain: 2 })
    this.geometries.push(waterGeometry)

    this.rain = this.resources.own(
      new RainEffect(
        (a, b) => this.physics.trace(a, b),
        this.lowPower,
        (options.seed ?? 0) >>> 0,
        this.lampLights.map(({ light }) => light),
        this.moon,
        !!options.reducedMotion,
        uniforms,
        this.simulation.available,
        { ambient: this.ambient, fog: this.fog },
      ),
    )
    this.rain.setRainState(options.rain ?? DEFAULT_RAIN)
    this.rain.setWaterContact(this.simulation.contact)
    this.rain.prime()
    if (this.details && this.simulation.available)
      this.rain.setImpactSlopes(this.details.impactSlopes)
    this.scene.add(this.rain.group)
    this.water.material.uniforms.uRainSlopeMap.value = this.rain.texture
    uniforms.uRainSlopesEnabled.value = this.simulation.available ? 1 : 0

    this.camera.position.set(CAMERA_REST.x, CAMERA_REST.y, CAMERA_REST.z)
    this.camera.lookAt(0, this.mobile ? 2.3 : 7.3, -25)

    this.resize()
    this.resources.own({ dispose: () => this.removeListeners() })
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointermove', this.onPointerMove, { passive: true })
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerUp)
    this.renderer.domElement.addEventListener('pointerleave', this.onPointerLeave)
    this.renderer.domElement.addEventListener('lostpointercapture', this.onLostCapture)
    this.renderer.domElement.addEventListener('wheel', this.onWheel, { passive: false })
    this.renderer.domElement.addEventListener('pointerdown', this.onTouchDown)
    window.addEventListener('pointermove', this.onTouchMove, { passive: true })
    window.addEventListener('pointerup', this.onTouchUp)
    window.addEventListener('pointercancel', this.onTouchUp)
    window.addEventListener('blur', this.onActivityChange)
    window.addEventListener('focus', this.onActivityChange)
    document.addEventListener('visibilitychange', this.onActivityChange)
    if (this.lowPower && !this.reducedMotion) this.tilt.start()
    this.lastFrameAt = performance.now()
  }

  private buildWorld(prepared: PreparedWorld) {
    const { world, terrain } = prepared
    const seed = world.seed
    const meshes = [
      {
        data: terrain.surface,
        material: createTerrainMaterial(this.terrainSky, this.terrainTextures),
      },
      {
        data: terrain.boulders,
        material: createBoulderMaterial(this.terrainSky, this.terrainTextures),
      },
    ]
    for (const { data, material } of meshes) {
      this.materials.push(this.resources.own(material))
      if (!data.indices.length) continue
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(data.positions, 3))
      geometry.setAttribute('normal', new BufferAttribute(data.normals, 3, true))
      geometry.setAttribute('surface', new BufferAttribute(data.surface, 4, true))
      geometry.setIndex(new BufferAttribute(data.indices, 1))
      geometry.computeBoundingSphere()
      this.geometries.push(this.resources.own(geometry))
      const mesh = new Mesh(geometry, material)
      mesh.receiveShadow = true
      mesh.updateMatrixWorld(true)
      mesh.matrixAutoUpdate = mesh.matrixWorldAutoUpdate = false
      this.voxelGroup.add(mesh)
      this.objects.push(mesh)
    }

    this.buildShadowCasters()

    const bulbGeometry = new SphereGeometry(0.11, 6, 5)
    const glowGeometry = new PlaneGeometry(2.0, 2.0)
    this.geometries.push(this.resources.own(bulbGeometry), this.resources.own(glowGeometry))
    // Every cube shadow costs six caster renders plus a cube sample per lit pixel,
    // so only the brightest lanterns cast; the rest still light the bank.
    const shadowLamps = new Set(
      world.lamps
        .map((lamp, index) => ({ index, intensity: lamp.intensity }))
        .toSorted((a, b) => b.intensity - a.intensity)
        .slice(0, this.lowPower ? 1 : 2)
        .map((entry) => entry.index),
    )
    // One glow material serves every lantern: its strength is a per-object
    // uniform, so the node graph and pipeline are built once, not per lamp.
    const glowStrengths = new WeakMap<Object3D, { value: number }>()
    const glowMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      ...GLOW_BLENDING,
      depthWrite: false,
      side: DoubleSide,
      // Fog would mix the opaque additive quad toward the fog colour and light up its square.
      fog: false,
    })
    const glowStrength = uniform(0).onObjectUpdate(({ object }) =>
      object ? (glowStrengths.get(object)?.value ?? 0) : 0,
    )
    const p = uv().sub(0.5).mul(2)
    const r = p.dot(p)
    glowMaterial.fragmentNode = vec4(
      uniform(new Color(0xffb46b))
        .mul(
          exp(r.mul(-39))
            .mul(0.76)
            .add(exp(r.mul(-5.5)).mul(0.095)),
        )
        .mul(glowStrength),
      1,
    )
    this.materials.push(this.resources.own(glowMaterial))
    world.lamps.forEach((lamp, index) => {
      const bulb = new Mesh(
        bulbGeometry,
        new MeshBasicNodeMaterial({
          color: 0xffc37a,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      )
      // Waterfall and splashes draw at renderOrder 2; lamps must blend after them.
      bulb.renderOrder = 3
      bulb.position.set(lamp.x, lamp.y, lamp.z)
      this.scene.add(bulb)
      this.objects.push(bulb)
      this.materials.push(this.resources.own(bulb.material))
      const light = new PointLight(0xffab5e, 22 * lamp.intensity, 8, 2)
      light.position.copy(bulb.position)
      this.configurePointShadow(light, shadowLamps.has(index))
      this.scene.add(light)
      this.objects.push(light)
      const strength = { value: 0 }
      const glow = new Mesh(glowGeometry, glowMaterial)
      glowStrengths.set(glow, strength)
      glow.renderOrder = 3
      glow.position.copy(bulb.position)
      glow.frustumCulled = false
      this.scene.add(glow)
      this.objects.push(glow)
      this.lampLights.push({
        source: lamp,
        light,
        bulb,
        glow,
        color: bulb.material.color.clone(),
        glowStrength: strength,
        shadowPosition: light.position.clone(),
      })
    })
    // The forest joins before the first frame; see `addVegetation`.
    this.vegetationGroup.name = 'Vegetation'
    this.scene.add(this.vegetationGroup)

    // A few dim, square flecks drift in depth. They provide a living scale cue without
    // turning the open sky into a particle field.
    let randomState = (seed ^ 0x6a09e667) >>> 0
    const random = () => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
      return randomState / 0x1_0000_0000
    }
    const moteCount = this.mobile ? 6 : 16
    const moteGeometry = new BoxGeometry(1, 1, 1)
    const moteMaterial = new MeshBasicNodeMaterial({
      color: 0x5b7080,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    })
    const moteMesh = new InstancedMesh(moteGeometry, moteMaterial, moteCount)
    for (let index = 0; index < moteCount; index += 1) {
      const z = -11 - random() * 65
      const x = (random() - 0.5) * (this.mobile ? 23 : 110)
      const size = 0.03 + random() * 0.045
      const mote = {
        x,
        y: 1.5 + random() * 12,
        z,
        size,
        phase: random() * Math.PI * 2,
        speed: 0.11 + random() * 0.13,
      }
      this.motes.push(mote)
      this.moteTransform.position.set(mote.x, mote.y, mote.z)
      this.moteTransform.scale.setScalar(mote.size)
      this.moteTransform.updateMatrix()
      moteMesh.setMatrixAt(index, this.moteTransform.matrix)
    }
    moteMesh.instanceMatrix.needsUpdate = true
    moteMesh.computeBoundingSphere()
    this.moteMesh = moteMesh
    this.scene.add(moteMesh)
    this.objects.push(moteMesh)
    this.geometries.push(this.resources.own(moteGeometry))
    this.materials.push(this.resources.own(moteMaterial))
    if (this.options.sceneDetails !== false)
      this.details = this.resources.own(
        new SceneDetails(
          this.scene,
          world,
          this.mobile,
          this.reducedMotion ?? false,
          this.physics,
          this.options.detailEnvironment,
        ),
      )
    const listener = this.options.onWaterSound
    if (listener)
      this.details?.setSoundHandler((kind, x, z, energy) => {
        if (this.disposed) return
        this.soundPosition.set(x, WATER_LEVEL, z)
        const distance = this.soundPosition.distanceTo(this.camera.position)
        const place = pointSound(distance, this.soundPosition.project(this.camera).x)
        listener({ kind, intensity: energy * place.attenuation * this.intro, pan: place.pan })
      })
  }

  setReducedMotion(value: boolean) {
    if (this.disposed || value === this.reducedMotion) return
    const now = performance.now()
    this.solarClock = new SolarClock(
      this.solarClock.seconds(this.solarClock.elapsed(now)),
      value,
      now,
      this.solarClock.timeScale,
    )
    this.reducedMotion = value
    if (value) {
      this.scrub.reset()
      this.clouds.cursorTrace.clear()
      // A frozen frame must not hold a stone or a flock in mid-air.
      this.stone.cancel()
      this.birds.cancel()
      this.leaves.clear()
      this.shockwave.cancel()
      // Frozen time would hold a gust's lean in place.
      this.vegetation?.gusts.clear()
    }
    if (this.lowPower && !value) this.tilt.start()
    this.lastFrameAt = now
    this.cancelFrame()
    this.requestFrame()
  }

  /** Feed the shared rain/solar state into the details; safe before or after the first frame. */
  setDetailEnvironment(environment: Partial<DetailEnvironment>) {
    if (this.disposed) return
    for (const key of ['rainIntensity', 'daylight'] as const) {
      const value = environment[key]
      if (Number.isFinite(value))
        this.detailEnvironment = { ...this.detailEnvironment, [key]: value }
    }
    this.details?.setEnvironment(environment)
    if (this.reducedMotion) this.requestFrame()
  }

  /** The terrain and boulder meshes, depth-only on the shadow layer, sharing their geometry. */
  private buildShadowCasters() {
    const material = new MeshBasicNodeMaterial()
    this.materials.push(this.resources.own(material))
    for (const source of this.voxelGroup.children) {
      if (!(source instanceof Mesh)) continue
      const mesh = new Mesh(source.geometry, material)
      mesh.castShadow = true
      mesh.layers.set(5)
      mesh.updateMatrixWorld(true)
      mesh.matrixAutoUpdate = mesh.matrixWorldAutoUpdate = false
      this.shadowGroup.add(mesh)
      this.objects.push(mesh)
    }
  }

  /** A lantern only needs a cube map when it is one of the shadow casters. */
  private configurePointShadow(light: PointLight, castsShadow: boolean) {
    if (!castsShadow) return
    light.castShadow = true
    light.shadow.autoUpdate = false
    this.resources.own(light.shadow)
    light.shadow.camera.layers.set(5)
    light.shadow.mapSize.setScalar(this.lowPower ? 256 : 512)
    light.shadow.camera.near = 0.08
    light.shadow.camera.far = light.distance || 30
    light.shadow.bias = -0.001
    light.shadow.normalBias = 0.035
  }

  private projectPointer(clientX: number, clientY: number): boolean {
    const canvas = this.renderer.domElement
    if (!seesWorld(document.elementFromPoint(clientX, clientY))) return false
    const bounds = this.canvasBounds ?? canvas.getBoundingClientRect()
    const x = ((clientX - bounds.left) / bounds.width) * 2 - 1
    const y = -((clientY - bounds.top) / bounds.height) * 2 + 1
    if (Math.abs(x) > 1 || Math.abs(y) > 1) return false
    this.rayNdc.set(x, y)
    this.raycaster.setFromCamera(this.rayNdc, this.camera)
    return true
  }

  /** Writes the water point under a client position into `target`, which it returns. */
  private hitWater(clientX: number, clientY: number, target: Vector3): Vector3 | null {
    return this.projectPointer(clientX, clientY) ? this.waterPointOnRay(target) : null
  }

  private waterPointOnRay(target: Vector3): Vector3 | null {
    const ray = this.raycaster.ray
    this.waterPlane.constant = -WATER_LEVEL
    if (!ray.intersectPlane(this.waterPlane, this.waterHit)) return null
    const wind = this.wind.sample(this.elapsed)
    for (let i = 0; i < 3; i++) {
      this.waterPlane.constant = -(
        this.simulation.contact.sample(this.waterHit.x, this.waterHit.z, this.elapsed, wind)[0] +
        this.pointerHeight
      )
      if (!ray.intersectPlane(this.waterPlane, this.waterHit)) return null
    }
    const distance = this.waterHit.distanceTo(this.camera.position)
    const index = lakeIndex(this.bed, this.waterHit.x, this.waterHit.z)
    if (distance > 130 || index < 0 || !this.bed.water[index]) return null
    // A crown in front of the water hides it from the pointer.
    if (raySpheres(ray.origin, ray.direction, this.vegetationPick, distance) < distance) return null
    // Conservative raster of the actual solids includes the banks and isolated stones.
    const cell = LAKE_BOUNDS.size / this.bed.resolution
    for (let d = 0; d < distance - 0.05; d += cell * 0.5) {
      const px = ray.origin.x + ray.direction.x * d
      const pz = ray.origin.z + ray.direction.z * d
      const i = lakeIndex(this.bed, px, pz)
      if (i >= 0 && (this.bed.obstacle[i] ?? -Infinity) >= ray.origin.y + ray.direction.y * d)
        return null
    }
    return target.copy(this.waterHit)
  }

  /**
   * Distance along the pointer ray to the first solid it meets: the colliders (ground, cliffs,
   * boulders) or a tree or shrub's crown, which has no collider. Infinity when it meets none.
   */
  private pointerSolidDistance(max = 130) {
    const ray = this.raycaster.ray
    const solid = this.physics.castDistance(ray.origin, ray.direction, max) ?? Infinity
    return Math.min(solid, raySpheres(ray.origin, ray.direction, this.vegetationPick, solid))
  }

  private updatePointerLight(
    pointerOnScene: boolean,
    waterPoint: Vector3 | null,
    nightStrength: number,
    dt: number,
  ) {
    let contact: Vector3 | null = null
    if (nightStrength > 0 && pointerOnScene && this.pointerType === 'mouse' && this.focused) {
      const ray = this.raycaster.ray
      const solid = this.pointerSolidDistance()
      if (solid < Infinity && (!waterPoint || solid < ray.origin.distanceTo(waterPoint)))
        contact = ray.at(solid, this.lightHit)
      else contact = waterPoint
    }
    this.pointerLight.update(
      contact,
      this.raycaster.ray.direction,
      nightStrength * this.intro,
      dt,
      this.reducedMotion,
      this.raycaster.ray.origin,
    )
    return contact
  }

  /** Cursor relief valves for the waterfall, clouds and rain; trails heal on their own. */
  private updateCursorWorld(
    pointerOnScene: boolean,
    waterPoint: Vector3 | null,
    dt: number,
    activeDelta: number,
  ) {
    const ray = this.raycaster.ray
    let solid: number | null = null
    const solidDistance = () => {
      if (solid === null) solid = this.pointerSolidDistance()
      return solid
    }
    let blockTarget = 0
    if (pointerOnScene && !this.reducedMotion && this.waterfall && this.details) {
      const hit = sampleWaterfallHit(ray.origin, ray.direction, this.waterfall, WATER_LEVEL)
      const waterDistance = waterPoint ? ray.origin.distanceTo(waterPoint) : Infinity
      if (
        hit &&
        hit.distance < waterDistance &&
        solidDistance() > hit.distance - WATERFALL_OCCLUSION_TOLERANCE
      ) {
        this.blockPoint.set(hit.across, hit.height)
        blockTarget = hit.strength * this.intro
      }
    }
    const rate = this.reducedMotion
      ? 1
      : 1 - Math.exp(-Math.max(0, dt) * (blockTarget > this.blockStrength ? 18 : 4.5))
    this.blockStrength += (blockTarget - this.blockStrength) * rate
    if (Math.abs(this.blockStrength - blockTarget) < 0.0005) this.blockStrength = blockTarget
    this.details?.setWaterfallBlock(this.blockPoint.x, this.blockPoint.y, 0.24, this.blockStrength)
    const skyPointer =
      (this.primaryMouseDown || this.skyPointerId >= 0) &&
      pointerOnScene &&
      !this.reducedMotion &&
      !waterPoint &&
      ray.direction.y > 0.02 &&
      solidDistance() === Infinity
        ? ray.direction
        : null
    if (!this.reducedMotion) this.clouds.cursorTrace.update(skyPointer, activeDelta, this.intro)
    if (pointerOnScene && !this.reducedMotion && this.rain.group.visible) {
      this.umbrella.x = ray.origin.x + ray.direction.x * 14
      this.umbrella.y = ray.origin.y + ray.direction.y * 14
      this.umbrella.z = ray.origin.z + ray.direction.z * 14
      this.rain.setRepulsor(this.umbrella)
    } else {
      this.rain.setRepulsor(null)
    }
  }

  private async processPointer() {
    const event = this.pendingPointer
    if (!event || this.pointerBusy || this.disposed) return
    this.pendingPointer = null
    this.pointerBusy = true
    const revision = this.pointerRevision
    try {
      let point = this.hitWater(event.x, event.y, this.strokeEnd)
      if (!point) {
        this.previousPointer = null
        return
      }
      this.pointerHeight = await this.simulation.heightAt(point.x, point.z)
      if (this.disposed || revision !== this.pointerRevision) return
      point = this.hitWater(event.x, event.y, this.strokeEnd)
      if (!point) {
        this.previousPointer = null
        return
      }
      const previous = this.previousPointer
      if (previous && (event.x !== previous.x || event.y !== previous.y)) {
        // Reproject both client positions with the SAME camera. Parallax is never input energy.
        const start = this.hitWater(previous.x, previous.y, this.strokeStart)
        if (start) {
          const distance = start.distanceTo(point)
          const pixels = Math.hypot(event.x - previous.x, event.y - previous.y)
          const { samples, radius, velocity } = waterStroke(
            pixels,
            (event.time - previous.time) / 1000,
            distance,
            this.dragging,
          )
          const projected = this.strokeSample
          const bounds = this.canvasBounds ?? this.renderer.domElement.getBoundingClientRect()
          for (let i = 1; i <= samples; i++) {
            // Equal world spacing avoids bunching pressure samples at the near
            // end of a vertical screen stroke. Still reject occluded/UI samples.
            projected
              .copy(start)
              .lerp(point, (i - 0.5) / samples)
              .project(this.camera)
            const contact = this.hitWater(
              bounds.left + (projected.x + 1) * bounds.width * 0.5,
              bounds.top + (1 - projected.y) * bounds.height * 0.5,
              this.strokeContact,
            )
            if (contact) this.simulation.addImpulse(contact.x, contact.z, radius, velocity)
          }
        }
      }
      this.previousPointer = event
    } finally {
      this.pointerBusy = false
    }
  }

  private setPrimaryMouseDown(active: boolean) {
    this.primaryMouseDown = active
  }

  private onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary) return
    this.interacted = true
    this.pointerStillSince = performance.now()
    this.details?.scatterFireflies()
    this.setPrimaryMouseDown(event.pointerType === 'mouse')
    this.pointerType = event.pointerType
    this.pointerActive = true
    this.pointerClient.set(event.clientX, event.clientY)
    if (this.reducedMotion) {
      this.requestFrame()
      return
    }
    if (this.projectPointer(event.clientX, event.clientY)) {
      const ray = this.raycaster.ray
      const padding =
        (2 *
          Math.tan((this.camera.fov * Math.PI) / 360) *
          (event.pointerType === 'touch' ? 18 : 10)) /
        this.height
      const solid = this.physics.castDistance(ray.origin, ray.direction, 130) ?? 130
      const buoy = this.details?.grabFloater(ray, padding, solid)
      if (buoy) {
        this.grabPointerId = event.pointerId
        this.grabPlane.setFromNormalAndCoplanarPoint(
          this.camera.getWorldDirection(this.grabNormal),
          buoy,
        )
        this.previousPointer = this.pendingPointer = null
        this.pointerRevision += 1
        this.lastTap = null
        document.documentElement.dataset.sceneGrab = 'true'
        this.renderer.domElement.setPointerCapture(event.pointerId)
        return
      }
    }
    const point = this.hitWater(event.clientX, event.clientY, this.pressPoint)
    // Off the water, the press may startle birds from a crown or make a wish on the night sky;
    // both read the pointer ray, so it must have been cast for this very press.
    if (!point && this.projectPointer(event.clientX, event.clientY)) {
      if (this.startleCrown()) return
      this.wishOnStar()
    }
    if (!point) {
      if (event.pointerType === 'touch') {
        this.skyPointerId = event.pointerId
        this.renderer.domElement.setPointerCapture(event.pointerId)
      }
      return
    }
    this.bait = { x: point.x, z: point.z, born: this.elapsed }
    this.details?.pointerBurst(point.x, point.z, 0.55, this.elapsed, this.wind.sample(this.elapsed))
    this.dragging = true
    this.dragPointerId = event.pointerId
    this.pointerType = event.pointerType
    this.pointerActive = true
    this.pointerClient.set(event.clientX, event.clientY)
    this.previousPointer = { x: event.clientX, y: event.clientY, time: event.timeStamp }
    this.pendingPointer = { x: event.clientX, y: event.clientY, time: event.timeStamp }
    this.flick.length = 0
    this.flick.push({ x: event.clientX, y: event.clientY, time: event.timeStamp })
    this.shockwave.start(point.x, point.z, event.clientX, event.clientY, performance.now() / 1000)
    this.renderer.domElement.setPointerCapture(event.pointerId)
  }

  private onPointerMove = (event: PointerEvent) => {
    if (!this.focused || document.hidden) return
    if (
      !event.isPrimary ||
      (this.grabPointerId >= 0 && event.pointerId !== this.grabPointerId) ||
      (this.dragging && event.pointerId !== this.dragPointerId) ||
      (this.skyPointerId >= 0 && event.pointerId !== this.skyPointerId)
    )
      return
    this.pointerType = event.pointerType
    this.setPrimaryMouseDown(event.pointerType === 'mouse' && (event.buttons & 1) !== 0)
    this.pointerActive = event.pointerType !== 'touch' || event.buttons !== 0
    if (this.grabPointerId >= 0) {
      this.pointerClient.set(event.clientX, event.clientY)
      this.moveGrabbedFloater()
      if ((event.buttons & 1) === 0) this.onPointerLeave()
      return
    }
    this.target.set(
      clamp((event.clientX / this.width) * 2 - 1, -1, 1),
      clamp((event.clientY / this.height) * 2 - 1, -1, 1),
    )
    if (this.pointerClient.x === event.clientX && this.pointerClient.y === event.clientY) return
    this.pointerClient.set(event.clientX, event.clientY)
    this.pointerStillSince = performance.now()
    if (this.reducedMotion) {
      this.requestFrame()
      return
    }
    if (!this.pointerActive) {
      this.previousPointer = null
      this.pendingPointer = null
      this.pointerRevision += 1
      return
    }
    this.pendingPointer = {
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp,
    }
    if (this.dragging) {
      this.shockwave.move(event.clientX, event.clientY)
      this.flick.push({ x: event.clientX, y: event.clientY, time: event.timeStamp })
      if (this.flick.length > 12) this.flick.shift()
    }
  }

  /**
   * A quick flick across the water throws a stone: it lands where the gesture ended and skips
   * on in the gesture's direction, further for a faster flick. Speed is read on the water plane
   * over at least the gesture's last 40 ms, so a slow drag only stirs the surface.
   */
  private throwStone(event: PointerEvent): boolean {
    if (this.reducedMotion || this.disposed) return false
    // Measure from the newest sample at least 40 ms old, or from the press. The newest move
    // often sits on the release point itself when events arrive coalesced on a busy frame.
    const from = flickOrigin(this.flick, event.timeStamp)
    this.flick.length = 0
    const elapsed = from ? event.timeStamp - from.time : 0
    if (!from || elapsed < 8 || elapsed > 300) return false
    const start = this.hitWater(from.x, from.y, this.flickStart)
    const end = start && this.hitWater(event.clientX, event.clientY, this.flickEnd)
    if (!start || !end) return false
    const seconds = elapsed / 1000
    const dx = end.x - start.x,
      dz = end.z - start.z
    const speed = Math.hypot(dx, dz) / seconds
    // A tap or a slow drag throws nothing.
    if (!(speed >= SKIP.minSpeed)) return false
    this.throwFrom(end, { x: dx, z: dz }, speed, event.pointerType)
    return true
  }

  /** A double tap on the night lake sets a paper lantern afloat where it landed. */
  private tapWater(event: PointerEvent) {
    const tap = { x: event.clientX, y: event.clientY, time: event.timeStamp }
    const double = isDoubleTap(this.lastTap, tap)
    this.lastTap = double ? null : tap
    if (!double || this.daylight > 0.25) return
    const point = this.hitWater(event.clientX, event.clientY, this.lanternPoint)
    if (point) this.lanterns.place(point.x, point.z, this.elapsed)
  }

  /**
   * A press on a tree's crown startles a flock out of it, by day. The pointer ray is already
   * set by the press; it must meet the crown before any ground or rock.
   */
  private startleCrown() {
    if (this.birds.active || this.daylight < 0.2) return false
    const ray = this.raycaster.ray
    const solid = this.physics.castDistance(ray.origin, ray.direction, 130) ?? Infinity
    const crown = raySpheres(ray.origin, ray.direction, this.vegetationPick, solid)
    if (!(crown < solid)) return false
    this.launchFlock(ray.at(crown, this.flockStart))
    return true
  }

  /**
   * A press on the clear night sky, where the pointer ray meets nothing, makes a wish: a few
   * shooting stars fall from that point.
   */
  private wishOnStar() {
    const ray = this.raycaster.ray
    if (this.daylight > 0.05 || this.weather === 'cloudy' || this.weather === 'overcast') return
    if (ray.direction.y < 0.03 || this.pointerSolidDistance() < Infinity) return
    this.shootingStars.wish(this.rayNdc.x, this.rayNdc.y)
  }

  private launchFlock(start: Vector3) {
    this.flockCount++
    this.birds.launch(
      start,
      this.camera.position,
      ((this.seed ^ (this.flockCount * 0x9e37)) >>> 0) + 1,
    )
    this.nextFlockAt = this.elapsed + FLOCK_GAP[0] + Math.random() * (FLOCK_GAP[1] - FLOCK_GAP[0])
  }

  /**
   * Now and then by day a flock leaves a crown in view on its own. Crowns are picked from the
   * tall ones (trees, not shrubs) that project inside the frame.
   */
  private updateBirds(dt: number, rain: number) {
    if (this.reducedMotion) {
      if (this.birds.active) this.birds.cancel()
      return
    }
    this.birds.update(dt)
    if (this.birds.active || this.elapsed < this.nextFlockAt) return
    if (this.daylight < 0.35 || rain > 0.3) {
      this.nextFlockAt = this.elapsed + 10
      return
    }
    const pick = this.vegetationPick
    const crownTop = (i: number, target: Vector3) =>
      target.set(pick[i] ?? 0, (pick[i + 1] ?? 0) + (pick[i + 3] ?? 0) * 0.6, pick[i + 2] ?? 0)
    const crowns: number[] = []
    for (let i = 0; i + 3 < pick.length; i += 4) {
      // Broad bands high above the water: tree crowns, not shrubs.
      if ((pick[i + 3] ?? 0) < 1.5 || (pick[i + 1] ?? 0) < WATER_LEVEL + 4) continue
      const projected = crownTop(i, this.flockStart).project(this.camera)
      if (Math.abs(projected.x) < 0.85 && Math.abs(projected.y) < 0.85 && projected.z < 1)
        crowns.push(i)
    }
    const index = crowns[Math.floor(Math.random() * crowns.length)]
    if (index === undefined) this.nextFlockAt = this.elapsed + 10
    else this.launchFlock(crownTop(index, this.flockStart))
  }

  /**
   * Lightning in a thunderstorm or very heavy rain: flashes light the clouds and the scene, and
   * each strike's thunder goes to the sound. None under reduced motion, which also spares
   * photosensitive visitors any flash.
   */
  private updateLightning() {
    const stormy =
      !this.reducedMotion &&
      this.intro === 1 &&
      (this.options.storm === true || this.rain.simulation.state.intensity >= LIGHTNING.stormRain)
    const flash = this.lightning.update(this.elapsed, stormy, this.options.onThunder)
    this.skyMaterial.uniforms.uFlash.value = flash
    return flash
  }

  /**
   * A long press let go: one broad wave rolls out from the spot to the banks, lifting what
   * floats, with a ring of splashes, a low note and, on touch, a buzz in the hand.
   */
  private releaseShockwave(
    wave: Readonly<{ x: number; z: number; charge: number }>,
    pointerType: string,
  ) {
    const { radius, velocity } = shockImpulse(wave.charge)
    this.simulation.addImpulse(wave.x, wave.z, radius, velocity)
    const wind = this.wind.sample(this.elapsed)
    const bursts = 6 + Math.round(4 * wave.charge)
    for (let i = 0; i < bursts; i++) {
      const angle = (i / bursts) * Math.PI * 2
      const x = wave.x + Math.cos(angle) * radius,
        z = wave.z + Math.sin(angle) * radius
      if (this.isOpenWater(x, z))
        this.details?.pointerBurst(x, z, 0.4 + 0.4 * wave.charge, this.elapsed, wind)
    }
    this.bait = null
    const listener = this.options.onShockwave
    if (!listener) return
    this.soundPosition.set(wave.x, WATER_LEVEL, wave.z)
    const distance = this.soundPosition.distanceTo(this.camera.position)
    const place = pointSound(distance, this.soundPosition.project(this.camera).x)
    listener({ charge: wave.charge, intensity: place.attenuation, pan: place.pan, pointerType })
  }

  /**
   * A quick sweep of the pointer across the scene raises a gust that runs through the grass and
   * trees in the sweep's direction. The direction is read on the ground: both ends of this
   * frame's stroke are cast into the world, the newest last so the pointer ray stays current.
   */
  private updateGusts(pointerOnScene: boolean, dt: number) {
    const previous = this.sweepClient
    const current = this.pointerClient
    const pixels = Math.hypot(current.x - previous.x, current.y - previous.y) / Math.max(dt, 1e-3)
    const strength = dt > 0 ? sweepStrength(pixels) : 0
    const vegetation = this.vegetation
    const ready = pointerOnScene && !this.reducedMotion && vegetation && strength > 0
    const from = ready && this.pointerWorld(previous.x, previous.y, this.sweepFrom)
    const to = from && this.pointerWorld(current.x, current.y, this.sweepTo)
    previous.copy(current)
    if (!vegetation || !from || !to) return
    const dx = to.x - from.x,
      dz = to.z - from.z
    const stroke = Math.hypot(dx, dz)
    // The front runs on at the pointer's own pace over the ground.
    if (stroke > 0.3)
      vegetation.gusts.raise(
        to.x,
        to.z,
        dx,
        dz,
        strength,
        this.elapsed,
        stroke / Math.max(dt, 1e-3),
      )
  }

  /** The first solid, crown or water the pointer at a client position meets, or null. */
  private pointerWorld(clientX: number, clientY: number, target: Vector3): Vector3 | null {
    if (!this.projectPointer(clientX, clientY)) return null
    const ray = this.raycaster.ray
    const water = this.waterPointOnRay(this.waterHitScratch)
    const solid = this.pointerSolidDistance()
    if (solid < Infinity && (!water || solid < ray.origin.distanceTo(water)))
      return ray.at(solid, target)
    return water ? target.copy(water) : null
  }

  /** Places the sun's lens flare: where its disc projects on the frame, and how strongly. */
  private updateFlare(light: LightingState) {
    const ndc = this.flarePoint
      .copy(light.sunApparent)
      .multiplyScalar(400)
      .add(this.camera.position)
      .project(this.camera)
    const target = this.showSun
      ? flareStrength(ndc, light.sunDirection.y) * this.sunInView(light) * light.weatherDiffuse ** 4
      : 0
    // Eases in and out over a few frames, so a crown swaying across the disc does not blink it.
    this.flareLevel += (target - this.flareLevel) * (this.reducedMotion ? 1 : 0.2)
    this.depthFocus.setFlare((ndc.x + 1) / 2, (ndc.y + 1) / 2, this.flareLevel * this.intro)
  }

  /** 1 when nothing solid (ground, rock, crown) stands between the eye and the sun, else 0. */
  private sunInView(light: LightingState) {
    const origin = this.camera.position,
      direction = light.sunApparent
    if (this.physics.castDistance(origin, direction, 400) !== null) return 0
    return raySpheres(origin, direction, this.vegetationPick, Infinity) < Infinity ? 0 : 1
  }

  private updateLanterns(wind: WindState, daylight: number) {
    this.lanterns.update(
      this.elapsed,
      wind,
      1 - daylight,
      (x, z) => this.simulation.contact.sample(x, z, this.elapsed, wind)[0],
      (x, z) => this.isOpenWater(x, z),
      this.reducedMotion,
    )
  }

  /** While a press charges, faint ripples gather under it. */
  private updateShockwave(seconds: number) {
    const pressed = this.shockwave.pressed
    const charge = this.shockwave.charge(seconds)
    if (pressed && charge > 0 && seconds >= this.nextShockRipple) {
      this.nextShockRipple = seconds + SHOCK_RIPPLE
      this.simulation.addImpulse(pressed.x, pressed.z, 0.4, -0.03 * charge)
    }
    this.shockwave.update(seconds)
  }

  private throwFrom(
    landing: Vector3,
    direction: { x: number; z: number },
    speed: number,
    pointerType: string,
  ) {
    const plan = planSkips(landing, direction, speed, (x, z) => this.isOpenWater(x, z))
    // From a hand low and a little right of the eye, as a right-handed skimmer throws.
    this.stoneHand
      .set(1.2, -0.9, -1.5)
      .applyQuaternion(this.camera.quaternion)
      .add(this.camera.position)
    this.stoneThrower = pointerType
    this.stone.throw(this.stoneHand, plan, this.elapsed)
  }

  /** Where a leaf falling at (x, z) from `fromY` comes to rest: the ground, or the lake. */
  private leafGround(x: number, z: number, fromY: number) {
    const origin = this.leafRayOrigin.set(x, fromY, z)
    const hit = this.physics.castDistance(origin, DOWN, 60)
    const ground = hit === null ? -Infinity : fromY - hit
    if (ground < WATER_LEVEL && this.isOpenWater(x, z)) return { y: WATER_LEVEL, water: true }
    return { y: Number.isFinite(ground) ? ground : WATER_LEVEL - 2, water: false }
  }

  private isOpenWater(x: number, z: number) {
    const index = lakeIndex(this.bed, x, z)
    return (
      index >= 0 &&
      Boolean(this.bed.water[index]) &&
      (this.bed.obstacle[index] ?? -Infinity) < WATER_LEVEL
    )
  }

  private updateStone() {
    this.stone.update(this.elapsed, (touchdown, index, last) => {
      const wind = this.wind.sample(this.elapsed)
      const energy = last ? 0.5 : touchdown.energy
      this.simulation.addImpulse(touchdown.x, touchdown.z, last ? 0.5 : 0.35, -0.09 * energy)
      this.details?.pointerBurst(touchdown.x, touchdown.z, 0.3 + 0.35 * energy, this.elapsed, wind)
      const listener = this.options.onStoneTouchdown
      if (!listener) return
      this.soundPosition.set(touchdown.x, WATER_LEVEL, touchdown.z)
      const distance = this.soundPosition.distanceTo(this.camera.position)
      const place = pointSound(distance, this.soundPosition.project(this.camera).x)
      listener({
        index,
        sinking: last,
        energy,
        intensity: place.attenuation * this.intro,
        pan: place.pan,
        pointerType: this.stoneThrower,
      })
    })
  }

  /** Shows a first visitor that the water answers: one long run of skips across the lake. */
  private throwDemo() {
    this.demoThrown = true
    const bounds = this.canvasBounds ?? this.renderer.domElement.getBoundingClientRect()
    for (const [u, v] of DEMO_LANDINGS) {
      const landing = this.hitWater(
        bounds.left + u * bounds.width,
        bounds.top + v * bounds.height,
        this.flickEnd,
      )
      if (!landing) continue
      const direction = {
        x: landing.x - this.camera.position.x,
        z: landing.z - this.camera.position.z,
      }
      this.throwFrom(landing, direction, 16, 'demo')
      return
    }
  }

  private onPointerUp = (event: PointerEvent) => {
    if (!event.isPrimary) return
    if (event.button === 0 || event.type === 'pointercancel') this.setPrimaryMouseDown(false)
    if (event.pointerId === this.grabPointerId) {
      this.details?.releaseFloater(event.type === 'pointercancel')
      this.grabPointerId = -1
      delete document.documentElement.dataset.sceneGrab
      if (this.renderer.domElement.hasPointerCapture(event.pointerId))
        this.renderer.domElement.releasePointerCapture(event.pointerId)
      if (event.pointerType === 'touch') this.onPointerLeave()
      return
    }
    if (event.pointerId === this.skyPointerId) {
      this.onPointerLeave()
      return
    }
    if (event.pointerType === 'touch' && event.pointerId !== this.dragPointerId) {
      this.onPointerLeave()
      return
    }
    if (event.pointerId !== this.dragPointerId) return
    const wave =
      event.type === 'pointerup' ? this.shockwave.release(performance.now() / 1000) : null
    if (wave) this.releaseShockwave(wave, event.pointerType)
    else if (event.type === 'pointerup' && !this.throwStone(event)) this.tapWater(event)
    this.dragging = false
    this.dragPointerId = -1
    if (event.type === 'pointercancel' || this.pointerType === 'touch') this.onPointerLeave()
    if (this.renderer.domElement.hasPointerCapture(event.pointerId))
      this.renderer.domElement.releasePointerCapture(event.pointerId)
  }

  /**
   * The wheel runs the day forward (down) or back (up); the clock returns to the real hour on
   * its own a few seconds after the last turn. Pinch-zoom (ctrl + wheel) and horizontal swipes
   * are left to the browser.
   */
  private onWheel = (event: WheelEvent) => {
    if (this.reducedMotion || event.ctrlKey || Math.abs(event.deltaY) < Math.abs(event.deltaX))
      return
    event.preventDefault()
    this.interacted = true
    this.scrub.scrub(
      wheelPixels(event.deltaY, event.deltaMode) * SCRUB.wheelSeconds,
      performance.now() / 1000,
    )
  }

  /** A second finger turns the press into a time scrub: no stone, no stirring, no sky drag. */
  private onTouchDown = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return
    this.touches.set(event.pointerId, event.clientY)
    if (this.touches.size === 2) this.onPointerLeave()
  }

  private onTouchMove = (event: PointerEvent) => {
    const previous = this.touches.get(event.pointerId)
    if (previous === undefined) return
    this.touches.set(event.pointerId, event.clientY)
    if (this.touches.size !== 2 || this.reducedMotion) return
    // Each finger carries half the swipe: dragging both up runs the day forward.
    this.scrub.scrub(
      ((previous - event.clientY) / 2) * SCRUB.touchSeconds,
      performance.now() / 1000,
    )
  }

  private onTouchUp = (event: PointerEvent) => {
    this.touches.delete(event.pointerId)
  }

  private onLostCapture = () => {
    if (this.dragging || this.skyPointerId >= 0 || this.grabPointerId >= 0) this.onPointerLeave()
  }

  private onPointerLeave = (event?: PointerEvent) => {
    if (
      event?.type === 'pointerleave' &&
      this.grabPointerId >= 0 &&
      this.renderer.domElement.hasPointerCapture(this.grabPointerId)
    )
      return
    this.shockwave.abort()
    const pointerId =
      this.grabPointerId >= 0
        ? this.grabPointerId
        : this.dragPointerId >= 0
          ? this.dragPointerId
          : this.skyPointerId
    this.details?.releaseFloater(true)
    this.grabPointerId = -1
    delete document.documentElement.dataset.sceneGrab
    this.setPrimaryMouseDown(false)
    this.skyPointerId = -1
    this.pointerActive = false
    this.dragging = false
    this.dragPointerId = -1
    this.previousPointer = null
    this.pendingPointer = null
    this.pointerRevision += 1
    this.waterPointerTarget.z = 0
    if (this.reducedMotion) this.requestFrame()
    if (pointerId >= 0 && this.renderer.domElement.hasPointerCapture(pointerId))
      this.renderer.domElement.releasePointerCapture(pointerId)
  }

  private moveGrabbedFloater() {
    if (this.grabPointerId < 0 || !this.projectPointer(this.pointerClient.x, this.pointerClient.y))
      return
    const target = this.raycaster.ray.intersectPlane(this.grabPlane, this.grabPoint)
    if (target) this.details?.moveFloater(target)
  }

  /** Background frames sleep between draws instead of waking on every display refresh. */
  private requestFrame() {
    if (
      !this.initialized ||
      this.disposed ||
      document.hidden ||
      this.frame !== 0 ||
      this.frameTimer !== 0
    )
      return
    if (this.focused || this.reducedMotion) {
      this.frame = requestAnimationFrame(this.onAnimationFrame)
    } else {
      const delay = Math.max(0, this.nextFrameAt - performance.now())
      this.frameTimer = window.setTimeout(() => {
        this.frameTimer = 0
        if (!this.disposed && !document.hidden)
          this.frame = requestAnimationFrame(this.onAnimationFrame)
      }, delay)
    }
  }

  private cancelFrame() {
    cancelAnimationFrame(this.frame)
    clearTimeout(this.frameTimer)
    this.frame = 0
    this.frameTimer = 0
  }

  private onAnimationFrame = (now: number) => {
    this.frame = 0
    if (this.disposed || document.hidden) return
    // Leave a little room for rAF timestamp jitter at the display's nominal frequency.
    const interval = 1000 / (this.focused ? (this.lowPower ? LOW_POWER_FPS : 60) : 12)
    if (!this.reducedMotion && now < this.nextFrameAt - 0.5) {
      this.requestFrame()
      return
    }
    // Carry display jitter only in the foreground; idle frames never catch up after a delay.
    this.nextFrameAt = this.focused ? this.nextFrameAt + interval : now + interval
    if (this.nextFrameAt <= now) this.nextFrameAt = now + interval
    const sampleStart = this.renderDiagnostics.frameStart(now)
    try {
      this.render(now)
    } catch (error) {
      console.warn('Landscape rendering failed:', error)
      this.options.onContextFailure()
      this.dispose()
    } finally {
      this.renderDiagnostics.frameEnd(sampleStart)
    }
  }

  private onActivityChange = () => {
    this.focused = document.hasFocus()
    this.onPointerLeave()
    this.cancelFrame()
    this.lastFrameAt = performance.now()
    this.nextFrameAt = this.focused ? 0 : this.lastFrameAt + 1000 / 12
    this.environmentAt = -Infinity
    // requestFrame also handles hidden pages and the final unlit reduced-motion frame.
    this.requestFrame()
  }

  /** Temporary URL parameters only initialize this state; weather may replace it later. */
  setRainState(state: RainState) {
    if (this.disposed) return
    this.rain.setRainState(state)
    this.resizeReflection()
    this.requestFrame()
  }

  private warmupScene() {
    const target = this.renderer.getRenderTarget(),
      face = this.renderer.getActiveCubeFace(),
      mip = this.renderer.getActiveMipmapLevel()
    try {
      const render = () => {
        this.water.renderReflection(this.renderer, this.scene, this.camera)
        this.renderer.setRenderTarget(this.depthFocus.target)
        this.renderer.render(this.scene, this.camera)
      }
      // A real offscreen pass also prepares nested render contexts (the fluid
      // capture inside the main view). No simulation step runs and the shared
      // canvas continues to contain the loader.
      if (this.details) this.details.warmup(render)
      else render()
      this.depthFocus.warmup(this.renderer)
    } finally {
      this.renderer.setRenderTarget(target, face, mip)
    }
  }

  /** Clouds, sky, rain, contrast, water simulation and waterfall fluid, one after another. */
  private async compilePasses(renderer: WebGPURenderer, light: LightingState) {
    await this.clouds.compileAsync()
    await this.skyAtmosphere.compileAsync()
    this.skyAtmosphere.update(light.sunDirection, light.skyExposure)
    await this.compileRain()
    await this.sceneContrast.compileAsync(renderer)
    await this.simulation.compileAsync()
    await this.details?.prepareFluid(renderer, this.camera)
  }

  private compileRain() {
    const compile = () => this.rain.compileAsync(this.renderer, this.camera)
    return this.details ? this.details.compileAsync(compile) : compile()
  }

  private snapshotPrograms(stage: string) {
    performance.measure(`programs:${stage}:${this.renderer.info.memory.programs}`)
  }

  private gpuInfo: (() => SceneGpuInfo) | undefined
  private renderCaptureHook: Window['sceneRenderCapture']
  private eliminationHook: SceneElimination | undefined

  /** Narrow benchmark hook; read by page.evaluate, never by the scene itself. */
  private publishDiagnostics() {
    this.gpuInfo = () => ({
      programs: this.renderer.info.memory.programs,
      frameCalls: this.renderer.info.render.frameCalls,
      drawCalls: this.renderer.info.render.drawCalls,
      triangles: this.renderer.info.render.triangles,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
    })
    window.sceneGpuInfo = this.gpuInfo
    this.renderCaptureHook = {
      start: () => this.renderDiagnostics.start(this.renderer),
      stop: () => this.renderDiagnostics.stop(),
      resolveGpu: () => this.renderDiagnostics.resolveGpu(),
    }
    window.sceneRenderCapture = this.renderCaptureHook
    this.eliminationHook = this.createElimination()
    window.sceneElimination = this.eliminationHook
  }

  /** Clearing layer masks removes a group from every camera without touching visibility state. */
  private createElimination(): SceneElimination {
    const groups: Record<string, readonly Object3D[]> = {
      water: [this.water],
      sky: [this.sky],
      terrain: [this.voxelGroup, this.shadowGroup],
      trees: [this.vegetationGroup],
      ...this.details?.debugGroups,
      rain: [this.rain.group],
      lamps: this.lampLights.flatMap(({ bulb, glow }) => [bulb, glow]),
      motes: this.moteMesh ? [this.moteMesh] : [],
    }
    const saved = new Map<Object3D, number>()
    const restore = () => {
      for (const [object, mask] of saved) object.layers.mask = mask
      saved.clear()
    }
    return {
      groups: Object.keys(groups).filter((name) => groups[name]?.length),
      hide: (name) => {
        restore()
        for (const root of (name && groups[name]) || [])
          root.traverse((object) => {
            saved.set(object, object.layers.mask)
            object.layers.mask = 0
          })
        this.requestFrame()
      },
    }
  }

  /** Capture render state synchronously: the loader borrows this renderer between yields. */
  private compileView(
    camera: Camera,
    target: RenderTarget | null,
    object: Object3D = this.scene,
    face = 0,
    withDetails = true,
  ) {
    const previous = this.renderer.getRenderTarget()
    const previousFace = this.renderer.getActiveCubeFace(),
      mip = this.renderer.getActiveMipmapLevel()
    try {
      this.renderer.setRenderTarget(target, face)
      const compile = () => this.renderer.compileAsync(object, camera, this.scene)
      return withDetails && this.details ? this.details.compileAsync(compile) : compile()
    } finally {
      this.renderer.setRenderTarget(previous, previousFace, mip)
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
  private async compileScene(
    signal: AbortSignal,
    renderer: WebGPURenderer,
    passes: Promise<unknown>,
  ) {
    await passes
    signal.throwIfAborted()
    // Establish the final environment texture before building any lit material variant.
    this.renderer.initRenderTarget(this.environmentTarget)
    await this.environmentFilter.compileCubemapShader()
    await preparationFrame(signal)
    this.filteredEnvironment = this.environmentFilter.fromCubemap(this.environmentTarget.texture)
    this.scene.environment = this.filteredEnvironment.texture
    this.water.material.uniforms.uEnvironment.value = this.filteredEnvironment.texture
    await preparationFrame(signal)
    this.environmentCamera.coordinateSystem = this.renderer.coordinateSystem
    this.environmentCamera.updateCoordinateSystem()
    this.environmentCamera.updateMatrixWorld()
    this.snapshotPrograms('environment')

    // Each task sets up its renderer and scene state when it runs, not when it is issued.
    const tasks: (() => Promise<unknown>)[] = []
    const issue = (compile: () => Promise<unknown>) => tasks.push(compile)

    // The probe's own traversal, with the planar water and the detail layer out:
    // those materials are invisible in the cube so compiling them would only mint
    // variants the probe never draws.
    performance.mark('compile:scene')
    const cubeCamera = this.environmentCamera.children.find((child) => child instanceof Camera)
    if (!cubeCamera) throw new Error('Missing environment cube camera')
    issue(() => {
      this.water.visible = false
      try {
        // All six faces use the same lighting, layers and attachment formats. Include
        // off-axis meshes once instead of compiling their cached variants on every face.
        return compileWithoutCulling(this.scene, () => {
          const compile = () =>
            this.compileView(cubeCamera, this.environmentTarget, this.scene, 0, false)
          return this.details ? this.details.probeHidden(compile) : compile()
        })
      } finally {
        this.water.visible = true
      }
    })

    this.compileShadowMaps(issue)
    // The forest casts its own shadows; every other view reaches it through the scene.
    if (this.vegetation) this.compileShadowMaps(issue, this.vegetationGroup)

    issue(() => this.submerged.compileAsync(renderer, this.scene, this.camera))
    issue(() => this.compileView(this.camera, this.depthFocus.target))
    issue(() => this.atmosphere.compileAsync(this.depthFocus.target, this.camera, this.moon))
    issue(() => this.depthFocus.compileAsync(renderer, this.camera))
    issue(() => this.water.compileSky(renderer, this.reflectedSky))
    for (const task of tasks) {
      // eslint-disable-next-line no-await-in-loop -- one compileAsync at a time, see above
      await task()
      signal.throwIfAborted()
    }

    const reflected = this.water.getReflectionCamera(this.camera)
    reflected.copy(this.camera)
    this.setReflectionLayers(reflected)
    // The mirror renders at the main view's depth and attachments, so it shares
    // that render context: once the view's builds have settled, this only adds
    // objects outside the main frustum and the mirrored pipelines.
    this.water.visible = false
    let mirror: Promise<unknown>
    try {
      mirror = this.compileView(reflected, this.water.getRenderTarget(reflected))
    } finally {
      this.water.visible = true
    }
    await mirror
    this.snapshotPrograms('scene')
    signal.throwIfAborted()

    this.moon.shadow.needsUpdate = true
    for (const lamp of this.lampLights) lamp.light.shadow.needsUpdate = true
    this.renderEnvironmentFaces([0, 1, 2, 3, 4, 5])
    this.environmentFace = 0
    this.filterEnvironment()
    this.captureReflectedSky()
    await preparationFrame(signal)
  }

  /**
   * The mirror sees the main view's layers except the waterfall's fluid volume,
   * mist and spray, which would rebuild the fluid pass and haze a view the lake
   * distorts beyond recognition; a cheap ribbon stands in for the falling sheet.
   * Foreground undergrowth sits below the mirror's useful detail.
   */
  private setReflectionLayers(reflected: Camera) {
    reflected.layers.mask = this.camera.layers.mask
    reflected.layers.disable(WATERFALL_FLUID_LAYER)
    reflected.layers.disable(UNDERGROWTH_LAYER)
    reflected.layers.enable(WATERFALL_REFLECTION_LAYER)
  }

  private updateEnvironment(now: number, atmosphereTime: number) {
    // Reuse broad indirect lighting; planar water reflections stay per-frame.
    // Exactly one cube face renders per interval, so the cost per frame stays
    // flat instead of spiking; a full refresh takes about half a second.
    const interval = this.focused ? (this.lowPower ? 200 : 90) : 60
    // A clock jump (time scrub, weather change) restarts the sweep immediately.
    const jump = atmosphereTime < this.environmentTime || atmosphereTime - this.environmentTime > 1
    if (jump) this.environmentFace = 0
    if (!jump && this.intro === 1 && now - this.environmentAt < interval) return
    const face = this.environmentFace
    this.environmentAt = now
    if (face === 0) this.environmentTime = atmosphereTime

    this.renderEnvironmentFaces([face])
    this.environmentFace = (face + 1) % 6
    if (this.environmentFace !== 0) return
    this.filterEnvironment()
  }

  /**
   * The lake's sky reflection follows the visible sky frame by frame: clouds parting under
   * the cursor or a weather change would otherwise wait for the next full probe sweep.
   * Discs stay out as in the probe; the water lighting model reflects the sun and moon.
   */
  private captureReflectedSky() {
    this.skyMaterial.uniforms.uShowSun.value = 0
    this.skyMaterial.uniforms.uShowMoon.value = 0
    try {
      this.water.captureSky(this.renderer, this.reflectedSky)
    } finally {
      this.skyMaterial.uniforms.uShowSun.value = this.showSun ? 1 : 0
      this.skyMaterial.uniforms.uShowMoon.value = 1
    }
  }

  /** Renders probe faces with the direct disc and planar water masked out. */
  private renderEnvironmentFaces(faces: readonly number[]) {
    this.water.visible = false
    const environmentIntensity = this.scene.environmentIntensity
    this.scene.environmentIntensity = 0
    // Direct solar energy already comes from the directional light. Excluding the
    // disc from the lighting probe keeps disc visibility independent of illumination.
    this.skyMaterial.uniforms.uShowSun.value = 0
    this.skyMaterial.uniforms.uShowMoon.value = 0
    try {
      for (const face of faces) this.renderEnvironmentFace(face)
    } finally {
      this.water.visible = true
      this.scene.environmentIntensity = environmentIntensity
      this.skyMaterial.uniforms.uShowSun.value = this.showSun ? 1 : 0
      this.skyMaterial.uniforms.uShowMoon.value = 1
    }
  }

  /** Filter once per completed sweep, before the main render. Lazy filtering
   *  inside a material upload would nest renderer calls and disturb bindings. */
  private filterEnvironment() {
    if (this.simulation.available) {
      this.filteredEnvironment = this.environmentFilter.fromCubemap(
        this.environmentTarget.texture,
        this.filteredEnvironment,
      )
      this.scene.environment = this.filteredEnvironment.texture
    }
    this.water.material.uniforms.uEnvironment.value =
      this.filteredEnvironment?.texture ?? this.environmentTarget.texture
  }

  /** CubeCamera.update for one face, so a refresh spreads over six frames. */
  private renderEnvironmentFace(face: number) {
    const camera = this.environmentCamera
    const target = this.environmentTarget
    if (camera.parent === null) camera.updateMatrixWorld()
    const faceCamera = camera.children[face]
    if (!(faceCamera instanceof Camera)) throw new Error('Missing environment cube camera')
    const previous = this.renderer.getRenderTarget(),
      previousFace = this.renderer.getActiveCubeFace(),
      previousMip = this.renderer.getActiveMipmapLevel()
    const generateMipmaps = target.texture.generateMipmaps
    // Mipmaps are generated during the render of the final face.
    target.texture.generateMipmaps = face === 5 && generateMipmaps
    try {
      this.renderer.setRenderTarget(target, face, camera.activeMipmapLevel)
      if (this.renderer.reversedDepthBuffer && !this.renderer.autoClear) this.renderer.clearDepth()
      const render = () => this.renderer.render(this.scene, faceCamera)
      // Same object set as the compile pass, so the probe never mints extra variants.
      if (this.details) this.details.probeHidden(render)
      else render()
    } finally {
      target.texture.generateMipmaps = generateMipmaps
      this.renderer.setRenderTarget(previous, previousFace, previousMip)
    }
    if (face === 5) target.texture.needsPMREMUpdate = true
  }

  /** The material used by the public shadow node is shared with the actual shadow pass. */
  /**
   * Builds the forest into the scene before it compiles, so the scene batch covers it for
   * every view (main, mirror, probe and its shadow maps). A failed preparation leaves the scene
   * without vegetation rather than failing the load.
   */
  private async addVegetation(pending: Promise<VegetationPart>, signal: AbortSignal) {
    let data: VegetationPart
    try {
      data = await pending
    } catch (error) {
      signal.throwIfAborted()
      if (!(error instanceof DOMException && error.name === 'AbortError'))
        console.warn('Vegetation preparation failed', error)
      return
    }
    signal.throwIfAborted()
    const vegetation = this.resources.own(
      new Vegetation(this.vegetationGroup, data, this.terrainTextures?.bark),
    )
    this.vegetation = vegetation
    this.vegetationPick = data.pick
    this.details?.setLeafSources(data.pick)
    this.birds.setObstacles(data.pick)
    this.leaves.setSources(data.pick)
    for (const mesh of vegetation.meshes)
      if (mesh.material instanceof MeshStandardNodeMaterial)
        this.receiveSceneLight(mesh.material, vegetation.pointerLight.get(mesh))
    this.details?.attachVegetation(vegetation.meshes)
    this.vegetationGroup.updateMatrixWorld(true)
    performance.mark('vegetation-presented')
  }

  /**
   * Cloud shadows, the pointer light and the main view's fog hand-off (volumetric air replaces
   * material fog there) for a lit scene material, including ones that join after the build.
   */
  private receiveSceneLight(
    material: MeshStandardNodeMaterial,
    pointerLight?: PointerLightResponse,
  ) {
    this.clouds.shadows.applyTo(material, this.camera)
    this.pointerLight.applyTo(material, pointerLight)
  }

  private compileShadowMaps(
    issue: (compile: () => Promise<unknown>) => void,
    casters: Object3D = this.shadowGroup,
  ) {
    for (const light of [this.moon, ...this.lampLights.map((lamp) => lamp.light)]) {
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
        const material = this.scene.overrideMaterial,
          background = this.scene.background
        try {
          const shadowMaterial = shadow(light).getShadowMaterial()
          // Shadow rendering flips front-sided casters. Keep that same variant while
          // compileAsync yields, rather than restoring its default front side.
          shadowMaterial.side = BackSide
          this.scene.overrideMaterial = shadowMaterial
          this.scene.background = null
          return this.compileView(light.shadow.camera, map, casters)
        } finally {
          this.scene.overrideMaterial = material
          this.scene.background = background
        }
      })
    }
  }

  /** Shadow casters (layer 5) are static terrain, so maps only follow light motion. */
  private updateShadows() {
    const direction = this.shadowProbe
      .copy(this.moon.position)
      .sub(this.moon.target.position)
      .normalize()
    // 5e-4 rad moves the far shadow edge by about half a 2048² texel.
    if (!(direction.dot(this.moonShadowDirection) > 1 - 1.25e-7)) {
      this.moon.shadow.needsUpdate = true
      this.moonShadowDirection.copy(direction)
    }
    if (this.nightLightFade === 0 || !this.lampLights.length) return
    // Lanterns sway slowly: refresh a cube map only once its lamp has drifted far
    // enough to reshape shadows, at most one lamp per frame in round-robin order.
    const threshold = this.lowPower ? 0.12 : 0.08
    const limit = threshold * threshold
    for (let i = 0; i < this.lampLights.length; i++) {
      this.lampShadowCursor = (this.lampShadowCursor + 1) % this.lampLights.length
      const lamp = this.lampLights[this.lampShadowCursor]
      if (!lamp?.light.castShadow) continue
      if (lamp.shadowPosition.distanceToSquared(lamp.light.position) < limit) continue
      lamp.shadowPosition.copy(lamp.light.position)
      lamp.light.shadow.needsUpdate = true
      break
    }
  }

  private applyLighting(light: LightingState) {
    this.moon.position.copy(light.direction).multiplyScalar(320).add(this.moon.target.position)
    this.moon.intensity = light.intensity
    this.moon.color.copy(light.color)
    this.ambient.color.copy(light.ambient)
    this.terrainSky.update(light.ambient)
    this.ambient.intensity = 1
    this.fog.color.copy(light.haze)
    this.fog.density = Math.sqrt(WEATHER[this.weather].extinction / 100)
    updateSkyLighting(this.skyMaterial, light, this.showSun)
    this.updateFlare(light)
  }

  private render = (now: number) => {
    if (this.disposed || document.hidden) return
    this.frame = 0
    if (!this.reducedMotion) this.requestFrame()
    const activeDelta = Math.max(0, (now - this.lastFrameAt) / 1000)
    const rainDelta = Math.min(activeDelta, 0.1)
    const dt = Math.min(rainDelta, 0.05)
    this.lastFrameAt = now
    if (!this.reducedMotion) this.elapsed += dt
    if (this.introStartedAt === null) {
      this.introStartedAt = now
      this.solarClock = this.solarClock.restartIntro(now)
    }
    this.intro = this.reducedMotion ? 1 : clamp((now - this.introStartedAt) / 2200, 0, 1)

    const atmosphereTime = this.solarClock.elapsed(now)
    this.scrub.update(rainDelta, now / 1000)
    const solarSeconds = this.solarClock.seconds(atmosphereTime) + this.scrub.offset
    const light = sampleLighting(wrapDay(solarSeconds), 0, this.weather, this.solar)
    const host = this.lightingHost
    if (host) {
      const enabled = String(light.localLightStrength > 0)
      if (host.dataset.localLights !== enabled) host.dataset.localLights = enabled
      // DOM fallback; the GPU glyph mask adapts independently at every pixel.
      host.dataset.sceneTone ??= light.ambientLuminance > 0.16 ? 'light' : 'dark'
    }

    const parallax = this.reducedMotion ? 0 : 1 - Math.exp(-dt * 2.8)
    if (this.tilt.active) this.target.x = this.tilt.value
    this.pointer.lerp(this.target, parallax)
    const idleDrift =
      this.reducedMotion || this.tilt.active ? 0 : Math.sin(this.elapsed * 0.17) * CAMERA_IDLE_DRIFT
    const target = cameraTarget(this.pointer.x, this.pointer.y, idleDrift)
    this.camera.position.x += (target.x - this.camera.position.x) * parallax
    this.camera.position.y += (target.y - this.camera.position.y) * parallax
    this.camera.position.z = CAMERA_REST.z
    this.camera.lookAt(this.camera.position.x * 0.22, this.mobile ? 2.3 : 7.3, -25)
    this.camera.updateMatrixWorld()
    this.moveGrabbedFloater()
    const pointerOnScene =
      this.pointerActive && this.projectPointer(this.pointerClient.x, this.pointerClient.y)
    const waterPoint =
      pointerOnScene && this.grabPointerId < 0 ? this.waterPointOnRay(this.frameWaterPoint) : null
    // Snapshot before processPointer() reprojects pending events into the same scratch vector.
    if (pointerOnScene) this.detailPointerNdc.copy(this.rayNdc)
    if (waterPoint)
      this.waterPointerTarget.set(waterPoint.x, waterPoint.z, light.pointerLightStrength)
    else this.waterPointerTarget.z = 0
    const contact = this.updatePointerLight(
      pointerOnScene,
      waterPoint,
      light.pointerLightStrength,
      dt,
    )
    this.updateGusts(pointerOnScene, activeDelta)
    // A cursor held still at night gathers the fireflies a little above what it points at.
    const gather =
      contact &&
      light.pointerLightStrength > 0.3 &&
      !this.primaryMouseDown &&
      now - this.pointerStillSince > FIREFLY_GATHER_DELAY * 1000
        ? this.gatherPoint.copy(contact).setY(contact.y + 0.9)
        : null
    this.updateCursorWorld(pointerOnScene, waterPoint, dt, activeDelta)
    void this.processPointer().catch(() => {
      this.previousPointer = null
    })
    const uniforms = this.water.material.uniforms
    this.applyLighting(light)
    this.skyAtmosphere.update(light.sunDirection, light.skyExposure)
    if (!this.reducedMotion) this.starTime += activeDelta
    this.shootingStars.advance(
      activeDelta,
      light.sunDirection.y,
      this.weather === 'cloudy' || this.weather === 'overcast',
      this.reducedMotion,
      this.camera,
    )
    this.skyMaterial.uniforms.uStarTime.value = this.starTime
    this.skyMaterial.uniforms.uMeteorAge.value = this.shootingStars.age
    this.skyMaterial.uniforms.uMeteorStart.value.copy(this.shootingStars.start)
    this.skyMaterial.uniforms.uMeteorEnd.value.copy(this.shootingStars.end)
    uniforms.uWaterScatter.value.copy(light.waterScatter)
    uniforms.uLightDirection.value.copy(light.direction)
    uniforms.uLightColor.value.copy(light.color).multiplyScalar(light.intensity)
    uniforms.uNight.value = 1 - light.daylight
    uniforms.uDirectSun.value =
      Math.max(0, (WEATHER[this.weather].diffuse - 0.5) / 0.5) *
      (1 - 0.5 * this.rain.simulation.state.intensity)
    const morningMist = mistFactor(light.sunDirection.y, light.weatherDiffuse)
    const sampled = sampleLook({
      sunHeight: light.sunDirection.y,
      daylight: light.daylight,
      rain: this.rain.simulation.state.intensity,
      mist: morningMist,
    })
    const flash = this.updateLightning()
    // A flash opens the whole frame, more at night when the eye has adapted to the dark, but
    // never past about twice the exposure: a stronger flash whited the sky and clouds out.
    const look =
      flash > 0
        ? { ...sampled, exposure: sampled.exposure * (1 + flash * (1.1 - 0.8 * light.daylight)) }
        : sampled
    this.fog.density = this.baseFogDensity * (1 + morningMist * 1.4) * Math.sqrt(look.haze)
    this.atmosphere.update(light, look)
    if (!this.reducedMotion) this.gradeFrame++
    this.grade.update(look, this.gradeFrame)
    uniforms.uBedInverseViewProjection.value.copy(this.submerged.inverseViewProjection)
    uniforms.uBedViewProjection.value.copy(this.submerged.viewProjection)
    const wind = this.wind.sample(this.elapsed)
    if (now - this.ambientStateAt >= 250) {
      this.ambientStateAt = now
      let waterfall = { intensity: 0, pan: 0 }
      if (this.waterfall) {
        const fall = this.waterfall
        this.waterfallAudioPosition.set(
          fall.x + fall.direction[0] * 0.8,
          WATER_LEVEL,
          fall.z + fall.direction[1] * 0.8,
        )
        const distance = this.waterfallAudioPosition.distanceTo(this.camera.position)
        const screenX = this.waterfallAudioPosition.project(this.camera).x
        waterfall = waterfallSound(fall.width, fall.top - WATER_LEVEL, distance, screenX)
        waterfall.intensity *= this.intro
      }
      this.options.onEnvironment?.({
        solarHour: wrapDay(solarSeconds) / 3600,
        daylight: light.daylight,
        windSpeed: wind.speed,
        rainIntensity: this.rain.simulation.state.intensity,
        waterfall,
      })
    }
    updateWindUniforms(this.windUniforms, wind)
    this.vegetation?.update(this.elapsed, wind.direction, wind.speed, light)
    if (!this.reducedMotion && this.vegetation)
      this.leaves.update(
        this.elapsed,
        rainDelta,
        wind,
        this.vegetation.breeze,
        this.vegetation.gusts,
      )
    const optics = sampleWaterOptics(
      this.rain.simulation.state.intensity,
      wind.speed,
      WEATHER[this.weather].diffuse,
    )
    uniforms.uWaterClarity.value = optics.clarity
    uniforms.uWaterAgitation.value = optics.agitation
    uniforms.uRainIntensity.value = this.rain.group.visible
      ? this.rain.simulation.state.intensity
      : 0
    // Airborne colonies follow the cursor's projected proximity. Terrain picking
    // jumps between bank heights and distant water and cannot drive their motion.
    let fireflyPointer = null
    if (pointerOnScene) {
      const canvasBounds = this.canvasBounds ?? this.renderer.domElement.getBoundingClientRect()
      fireflyPointer = {
        ndc: this.detailPointerNdc,
        camera: this.camera,
        width: canvasBounds.width,
        height: canvasBounds.height,
      }
    }
    const { rainIntensity, daylight } = this.detailEnvironment
    this.details?.setEnvironment({
      rainIntensity:
        typeof rainIntensity === 'number' && Number.isFinite(rainIntensity)
          ? rainIntensity
          : this.rain.simulation.state.intensity,
      daylight:
        typeof daylight === 'number' && Number.isFinite(daylight) ? daylight : light.daylight,
    })
    let bait: FishBait | null = null
    this.updateStone()
    this.updateShockwave(now / 1000)
    this.updateLanterns(this.wind.sample(this.elapsed), light.daylight)
    this.daylight = light.daylight
    this.updateBirds(rainDelta, this.rain.simulation.state.intensity)
    if (!this.demoThrown && !this.interacted && !this.reducedMotion && this.introStartedAt !== null)
      if (now - this.introStartedAt > DEMO_DELAY * 1000) this.throwDemo()
    if (this.bait && !this.reducedMotion) {
      const strength = Math.exp(-(this.elapsed - this.bait.born) / 6) * this.intro
      if (strength > 0.01) bait = { x: this.bait.x, z: this.bait.z, strength }
      else this.bait = null
    }
    this.details?.update(
      this.elapsed,
      dt,
      wind,
      waterPoint,
      fireflyPointer,
      light.moonIntensity,
      this.intro,
      light.pointerLightStrength,
      bait,
      gather,
    )
    const wake = this.details?.rayWake
    if (wake) {
      uniforms.uWake.value.set(wake.x, wake.z, wake.hx, wake.hz)
      uniforms.uWakeSpeed.value = wake.speed
    }
    this.submerged.update(this.elapsed)
    this.clouds.update(atmosphereTime)
    this.skyMaterial.uniforms.uTime.value = this.elapsed
    this.water.material.uniforms.uTime.value = this.elapsed
    const waterPointer = this.water.material.uniforms.uPointer.value
    // The contact point must stay under the cursor while the camera eases.
    // Only the optical reveal trails off; smoothing x/z makes the surface feel detached.
    waterPointer.x = this.waterPointerTarget.x
    waterPointer.y = this.waterPointerTarget.y
    waterPointer.z +=
      (this.waterPointerTarget.z - waterPointer.z) *
      (this.reducedMotion ? 1 : 1 - Math.exp(-dt * 8))
    if (light.pointerLightStrength === 0) waterPointer.z = 0
    this.nightLightFade = fadeNightLight(
      this.nightLightFade,
      light.localLightStrength,
      dt,
      this.reducedMotion,
    )
    for (const [index, lamp] of this.lampLights.entries()) {
      lamp.bulb.visible = lamp.glow.visible = this.nightLightFade > 0
      const source = lamp.source
      const motion = Math.sin(this.elapsed * source.speed + source.phase)
      // Long, independent quiet intervals separate soft changes tied to the bobbing.
      // A subset stays steady, so the bank never pulses as one synchronized light.
      const active =
        this.reducedMotion || source.phase < Math.PI * 0.45
          ? 0
          : smooth(0.15, 0.7, Math.sin(this.elapsed * source.speed * 0.29 + source.phase * 1.7))
      const breathing = 1 + motion * (0.1 + source.amplitude * 0.6) * active
      const delay = (0.5 + 0.5 * Math.sin(source.phase)) * 0.16
      const emergence = this.reducedMotion
        ? this.nightLightFade
        : smooth(delay, 0.84 + delay, this.nightLightFade)
      const presence = smooth(0.12 + index * 0.045, 0.55 + index * 0.045, this.intro) * emergence
      const energy = presence * breathing
      const drift = this.reducedMotion ? 0 : motion * source.amplitude * emergence
      const sway = this.reducedMotion ? 0 : source.driftRadius * emergence
      const descent = this.reducedMotion ? 0 : (source.y - source.groundY + 0.25) * (1 - emergence)
      lamp.bulb.position.set(
        source.x + Math.sin(this.elapsed * source.speed * 0.73 + source.phase) * sway,
        source.y + drift - descent,
        source.z + Math.cos(this.elapsed * source.speed * 0.61 + source.phase * 1.3) * sway * 0.7,
      )
      lamp.light.position.copy(lamp.bulb.position)
      lamp.glow.position.copy(lamp.bulb.position)
      lamp.glow.quaternion.copy(this.camera.quaternion)
      lamp.light.intensity = 22 * source.intensity * energy
      lamp.glowStrength.value = 1.15 * energy
      lamp.bulb.material.opacity = presence
      lamp.bulb.material.color.copy(lamp.color).multiplyScalar(breathing * 1.6)
    }
    if (this.moteMesh) {
      this.moteMesh.visible = this.nightLightFade > 0
      this.moteMesh.material.opacity = smooth(0.25, 0.9, this.intro) * 0.2 * this.nightLightFade
      if (this.moteMesh.visible && !this.reducedMotion) {
        for (const [index, mote] of this.motes.entries()) {
          this.moteTransform.position.set(
            mote.x + Math.sin(this.elapsed * mote.speed * 0.71 + mote.phase) * 0.11,
            mote.y + Math.sin(this.elapsed * mote.speed + mote.phase) * 0.22,
            mote.z,
          )
          this.moteTransform.scale.setScalar(mote.size)
          this.moteTransform.updateMatrix()
          this.moteMesh.setMatrixAt(index, this.moteTransform.matrix)
        }
        this.moteMesh.instanceMatrix.needsUpdate = true
      }
    }
    const diagnostics = this.renderDiagnostics
    const renderInfo = this.renderer.info.render
    if (!this.reducedMotion) {
      const pass = diagnostics.begin('water', renderInfo.calls)
      this.simulation.step(dt, this.elapsed)
      diagnostics.end(pass, renderInfo.calls)
    }
    uniforms.uState.value = this.simulation.texture

    this.rain.update(this.reducedMotion ? 0 : rainDelta, this.camera, smooth(0, 0.62, this.intro), {
      time: this.elapsed,
      wind,
      gust: this.wind.centreSpeed > 0 ? wind.speed / this.wind.centreSpeed : 1,
    })
    const slopes = diagnostics.begin('rainSlopes', renderInfo.calls)
    this.rain.renderSlopes(this.renderer, this.camera, this.elapsed)
    diagnostics.end(slopes, renderInfo.calls)
    this.updateShadows()
    const probe = diagnostics.begin('environment', renderInfo.calls)
    this.updateEnvironment(now, atmosphereTime)
    this.captureReflectedSky()
    diagnostics.end(probe, renderInfo.calls)
    const submerged = diagnostics.begin('submerged', renderInfo.calls)
    // The captured lakebed is static; only fish and caustics move in it, so both
    // halves refresh on alternate frames and the atlas persists in between.
    this.submergedFrame = (this.submergedFrame + 1) % 2
    if (this.reducedMotion || this.submergedFrame === 0)
      this.submerged.render(this.renderer, this.scene, this.camera)
    diagnostics.end(submerged, renderInfo.calls)
    const main = diagnostics.begin('main', renderInfo.calls)
    this.depthFocus.render(
      this.renderer,
      this.scene,
      this.camera,
      this.atmosphere,
      this.moon,
      this.water,
    )
    diagnostics.end(main, renderInfo.calls)
    const overlay = diagnostics.begin('rainOverlay', renderInfo.calls)
    this.rain.renderOverlay(this.renderer, this.scene, this.camera, this.depthFocus.depthTexture)
    diagnostics.end(overlay, renderInfo.calls)
    const contrast = diagnostics.begin('contrast', renderInfo.calls)
    this.sceneContrast.render(this.renderer, this.atmosphere.target.texture, this.canvasBounds)
    diagnostics.end(contrast, renderInfo.calls)
    if (!this.rendered) {
      this.rendered = true
      this.renderer.domElement.dataset.sceneRendered = 'true'
      performance.mark('landscape-presented')
      this.options.onFirstFrame()
    }
  }

  resize = () => {
    if (this.disposed) return
    // The canvas is fixed fullscreen; its rect only changes with the viewport.
    this.canvasBounds = this.renderer.domElement.getBoundingClientRect()
    const bounds = this.container.getBoundingClientRect()
    this.width = Math.max(1, bounds.width)
    this.height = Math.max(1, bounds.height)
    this.camera.aspect = this.width / this.height
    this.camera.updateProjectionMatrix()
    this.renderer.setPixelRatio(maxPixelRatio(this.lowPower))
    this.renderer.setSize(this.width, this.height, false)
    this.renderer.getDrawingBufferSize(this.drawingBufferSize)
    this.rain.resize(this.drawingBufferSize.x, this.drawingBufferSize.y)
    this.water.material.uniforms.uRainResolution.value.copy(this.drawingBufferSize)
    this.depthFocus.resize(
      this.drawingBufferSize.x,
      this.drawingBufferSize.y,
      this.width,
      this.height,
    )
    this.atmosphere.resize(this.drawingBufferSize.x, this.drawingBufferSize.y)
    this.grade.resize(this.drawingBufferSize.x, this.drawingBufferSize.y)
    this.sceneContrast.invalidate()
    this.submerged.resize(this.lowPower, this.drawingBufferSize.x, this.drawingBufferSize.y)
    this.water.material.uniforms.uBedTexel.value.copy(this.submerged.bedTexel)
    this.resizeReflection()
    if (this.reducedMotion && this.rendered) this.requestFrame()
  }

  private resizeReflection() {
    const rain = this.rain.group.visible
    const scale = this.lowPower ? (rain ? 0.5 : 0.36) : rain ? 0.78 : 0.62
    const detailed = rain && !this.lowPower
    const reflectionScale = Math.min(
      scale,
      (detailed ? 1536 : this.lowPower ? 768 : 1024) / this.drawingBufferSize.x,
      (detailed ? 1080 : this.lowPower ? 832 : 960) / this.drawingBufferSize.y,
    )
    this.water.reflectorNode.reflector.resolutionScale = reflectionScale
  }

  private removeListeners() {
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerUp)
    this.renderer.domElement.removeEventListener('pointerleave', this.onPointerLeave)
    this.renderer.domElement.removeEventListener('lostpointercapture', this.onLostCapture)
    this.renderer.domElement.removeEventListener('wheel', this.onWheel)
    this.renderer.domElement.removeEventListener('pointerdown', this.onTouchDown)
    window.removeEventListener('pointermove', this.onTouchMove)
    window.removeEventListener('pointerup', this.onTouchUp)
    window.removeEventListener('pointercancel', this.onTouchUp)
    window.removeEventListener('blur', this.onActivityChange)
    window.removeEventListener('focus', this.onActivityChange)
    document.removeEventListener('visibilitychange', this.onActivityChange)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.onPointerLeave()
    this.stone.mesh.removeFromParent()
    this.stone.dispose()
    this.shockwave.mesh.removeFromParent()
    this.shockwave.dispose()
    this.lanterns.mesh.removeFromParent()
    this.lanterns.dispose()
    this.birds.group.removeFromParent()
    this.birds.dispose()
    this.leaves.dispose()
    if (this.gpuInfo && window.sceneGpuInfo === this.gpuInfo) delete window.sceneGpuInfo
    if (this.renderCaptureHook && window.sceneRenderCapture === this.renderCaptureHook)
      delete window.sceneRenderCapture
    this.renderDiagnostics.dispose()
    if (this.eliminationHook && window.sceneElimination === this.eliminationHook) {
      this.eliminationHook.hide(null)
      delete window.sceneElimination
    }
    this.eliminationHook = undefined
    this.renderCaptureHook = undefined
    this.gpuInfo = undefined
    this.cancelFrame()
    this.removeListeners()
    this.tilt.dispose()
    for (const object of this.objects) {
      object.removeFromParent()
      if (object instanceof InstancedMesh) object.dispose()
    }
    this.scene.environment = null
    this.pointerRevision += 1
    this.filteredEnvironment?.dispose()
    this.resources.dispose()
    const host = this.lightingHost
    if (host) {
      delete host.dataset.localLights
      delete host.dataset.sceneTone
    }
  }
}
