import {
  AmbientLight,
  Camera,
  Color,
  DirectionalLight,
  FogExp2,
  Group,
  InstancedMesh,
  MeshStandardNodeMaterial,
  Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  ACESFilmicToneMapping,
  SRGBColorSpace,
  Scene,
  Vector2,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu'

import type { AmbientEnvironment } from '../audio/environment'
import type { WaterSoundEvent } from '../audio/water-sounds'
import { debugParams, sceneParams } from '../scene-params'
import { AmbientReport } from './ambient-report'
import type { AmbientFrame } from './ambient-report'
import { CAMERA_IDLE_DRIFT, CAMERA_REST, easeCamera } from './camera-rig'
import { installCompilationScheduler } from './compilation-scheduler'
import { CursorEffects } from './cursor-effects'
import { DepthFocus } from './depth-focus'
import { LOW_POWER_FPS, budgetScale, canvasPixelRatio, isLowPowerDevice } from './device-profile'
import { DeviceTilt } from './device-tilt'
import { SceneRenderDiagnostics } from './diagnostics'
import { EnvironmentProbe } from './environment-probe'
import { FramePasses } from './frame-passes'
import type { PassFrame } from './frame-passes'
import { FrameScheduler } from './frame-scheduler'
import { WATER_LEVEL } from './lake-bed'
import type { LakeBed } from './lake-bed'
import { FISH_LAYER } from './lake-fish'
import { LakeLanterns } from './lake-lanterns'
import { createLakeReflector } from './lake-water'
import type { LakeReflector } from './lake-water'
import type { WaterfallSite } from './lake-world'
import { LandscapeInput } from './landscape-input'
import type { ShockwaveEvent, StoneTouchdownEvent } from './landscape-input'
import type { LandscapeState } from './landscape-state'
import { LandscapeWildlife } from './landscape-wildlife'
import type { WildlifeFrame } from './landscape-wildlife'
import { LanternSystem, NightMotes } from './lantern-system'
import { createLightingState, fadeNightLight, mistFactor, sampleLighting } from './lighting'
import type { LightingState } from './lighting'
import { LIGHTNING, Lightning } from './lightning'
import type { Strike } from './lightning'
import { clamp, smoothstep } from './math'
import { createPhysicsWorld, loadPhysics } from './physics-world'
import type { PhysicsWorld } from './physics-world'
import { PointerLight } from './pointer-light'
import type { PointerLightResponse } from './pointer-light'
import { prepareWorldAsync } from './prepare-world'
import type { PreparedWorld } from './prepare-world'
import { RainEffect } from './rain-effect'
import type { RainSurfaceFrame } from './rain-effect'
import { DEFAULT_RAIN, UMBRELLA_RADIUS } from './rain-simulation'
import type { RainState } from './rain-simulation'
import { RenderScaleController } from './render-scale'
import { ResourceScope } from './resource-scope'
import {
  compilePasses,
  compileScene,
  preparationFrame,
  snapshotPrograms,
  warmupScene,
} from './scene-compile'
import type { CompileTargets } from './scene-compile'
import { SceneContrast } from './scene-contrast'
import { SceneDetails } from './scene-details'
import type { DetailEnvironment } from './scene-details'
import { SceneGrade } from './scene-grade'
import { publishSceneHooks } from './scene-hooks'
import { sampleLook } from './scene-look'
import type { SceneLook } from './scene-look'
import { ScenePicker, isOpenWater, placeSound } from './scene-picking'
import {
  buildTerrainMeshes,
  configureSkyLight,
  lightLake,
  mountLake,
  placeLake,
  pointLake,
  prepareLitScene,
} from './scene-setup'
import { resolveSeason, seasonalLife } from './season'
import type { Season, SeasonalLife } from './season'
import type { FaunaClimate } from './seasonal-fauna'
import { SkyAtmosphere } from './sky-atmosphere'
import { SkyDome } from './sky-dome'
import { updateSkyLighting } from './sky-material'
import { snowCover } from './snow-cover'
import type { SnowPush } from './snow-simulation'
import { DEFAULT_SOLAR, SolarClock, introGap, parseInitialTime, wrapDay } from './solar-clock'
import type { SolarEndpoints } from './solar-clock'
import { SPLASH_IMPACT_LAYER } from './splash-impacts'
import { SkippingStone } from './stone-skips'
import { SubmergedScene } from './submerged-scene'
import { SunFlare } from './sun-flare'
import { TerrainSkyFill } from './terrain-detail'
import { loadTerrainTextures } from './terrain-textures'
import type { TerrainTextures } from './terrain-textures'
import { TimeScrub } from './time-scrub'
import { UNDERGROWTH_LAYER, Vegetation } from './vegetation'
import { VolumetricClouds } from './volumetric-clouds'
import { VolumetricLight } from './volumetric-light'
import { sampleWaterOptics } from './water-optics'
import { WaterShockwave } from './water-shockwave'
import { WaterSimulation } from './water-simulation'
import { createWaterGeometry } from './water-surface'
import { WATERFALL_FLUID_LAYER, WATERFALL_REFLECTION_LAYER } from './waterfall-fluid'
import { WEATHER } from './weather'
import type { WeatherPreset } from './weather'
import { levelsCoverSky } from './weather-blend'
import { SceneWeatherState } from './weather-state'
import type { SceneWeatherInput } from './weather-state'
import { WeatherView } from './weather-view'
import { WindModel, updateWindUniforms } from './wind'
import type { WindOptions, WindState } from './wind'
import { createWindUniforms } from './wind-nodes'
import type { VegetationPart } from './world-data'

export type LandscapeEngineOptions = Readonly<{
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
  /** Temperature, fog and snow for the season's wildlife (bats, insects); see `seasonal-fauna.ts`. */
  climate?: FaunaClimate
  /**
   * Live weather may refresh later (`setWeather`): compile the clouds, rain and snow even when
   * the opening weather hides them, so a refresh never compiles after the first frame.
   */
  weatherMayChange?: boolean
}>

const COMPILE_STAGES = ['passes', 'environment', 'scene', 'warmup'] as const

/** A per-frame argument type made writable, for a scratch object reused across frames. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] }
/** Seconds after the first frame before an untouched scene skips a stone by itself. */
const DEMO_DELAY = 7
/** Seconds a cursor must rest at night before the fireflies come to it. */
const FIREFLY_GATHER_DELAY = 1.2
export class LandscapeEngine {
  private readonly renderDiagnostics = new SceneRenderDiagnostics()
  private readonly state: LandscapeState = {
    elapsed: 0,
    intro: 0,
    reducedMotion: false,
    daylight: 0,
    focused: document.hasFocus(),
  }
  private readonly options: Omit<LandscapeEngineOptions, 'prepared'>
  private readonly container: HTMLDivElement
  private readonly renderer: WebGPURenderer
  private readonly depthFocus: DepthFocus
  private readonly atmosphere: VolumetricLight
  private readonly skyAtmosphere: SkyAtmosphere
  private readonly sceneContrast: SceneContrast
  private readonly grade = new SceneGrade()
  private gradeFrame = 0
  private readonly waterfall: WaterfallSite | undefined
  private readonly soundPosition = new Vector3()
  private solarClock: SolarClock
  private readonly solar: SolarEndpoints
  private nightLightFade = 0
  /** The sky preset last requested; the scene draws `weatherState`'s blended levels. */
  private weather: WeatherPreset
  private readonly weatherState: SceneWeatherState
  private readonly showSun: boolean
  private readonly ambient = new AmbientLight()
  private readonly terrainSky = new TerrainSkyFill()
  private readonly baseFogDensity = 0.0105
  private readonly fog = new FogExp2(0x14202a, this.baseFogDensity)
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(54, 1, 0.05, 500)
  private readonly picker: ScenePicker
  private readonly input: LandscapeInput
  private readonly cursor: CursorEffects
  private readonly flare: SunFlare
  private readonly frames: FrameScheduler
  private readonly passes: FramePasses
  private readonly ambience: AmbientReport
  private readonly weatherView: WeatherView
  private readonly frameWaterPoint = new Vector3()
  private readonly pointerLight = new PointerLight()
  private readonly pointer = new Vector2(0, 0)
  private readonly detailPointerNdc = new Vector2()
  private readonly tilt = new DeviceTilt()
  private readonly objects: Object3D[] = []
  /** Reused each frame: the scene's lighting and the clouds' capture lighting. */
  private readonly light = createLightingState()
  private readonly cloudLight = createLightingState()
  /** The graded look of a lightning frame, written over the sampled one. */
  private readonly flashLook: { -readonly [K in keyof SceneLook]: SceneLook[K] } = {
    ...sampleLook({ sunHeight: 1, daylight: 1, rain: 0, mist: 0 }),
  }
  /** Dynamic resolution; null under `?dpr=`, which fixes the resolution for comparisons. */
  private readonly renderScale: RenderScaleController | null
  /** Pixel-budget share of the canvas resolution the scene renders at (`device-profile.ts`). */
  private budgetScale = 1
  /**
   * Frames stayed late at the smallest render scale: switch to the low-power pixel, probe and
   * reflection budgets. Only knobs that need no new shader programs follow it.
   */
  private reducedBudget = false
  private readonly sceneBufferSize = new Vector2()
  private readonly lamps: LanternSystem
  private readonly motes: NightMotes
  private vegetation: Vegetation | undefined
  /** Holds the forest, built before the first frame. */
  private readonly vegetationGroup = new Group()
  private readonly moon = new DirectionalLight(0xa3bfd6, 1.5)
  private readonly probe: EnvironmentProbe
  private readonly drawingBufferSize = new Vector2()
  /** Per-frame arguments, reused rather than allocated each frame. */
  private ambientFrame: Mutable<AmbientFrame> | undefined
  private wildlifeFrame: Mutable<WildlifeFrame> | undefined
  private passFrame: Mutable<PassFrame> | undefined
  private rainSurface: RainSurfaceFrame | undefined
  /** The cursor's gusts push the falling snow (bound once; none before the forest exists). */
  private readonly snowPush: SnowPush = (x, z, out) =>
    this.vegetation ? this.vegetation.gusts.pushAt(x, z, out) : 0
  private readonly water: LakeReflector
  private readonly simulation: WaterSimulation
  private readonly submerged: SubmergedScene
  private readonly bed: LakeBed
  private details: SceneDetails | undefined
  private detailEnvironment: Partial<DetailEnvironment> = {}
  private readonly physics: PhysicsWorld
  private readonly lightingHost: HTMLElement | null
  private readonly stone = new SkippingStone(WATER_LEVEL)
  /** The visitor's run through the day with the wheel or two fingers, over the real clock. */
  private readonly scrub = new TimeScrub()
  private readonly wildlife: LandscapeWildlife
  /** The visit's season (`season.ts`) and what it means for the wildlife. */
  private readonly season: Season
  private readonly life: SeasonalLife
  private readonly seed: number
  private readonly shockwave = new WaterShockwave(WATER_LEVEL)
  private readonly gatherPoint = new Vector3()
  private readonly lanterns = new LakeLanterns()
  private readonly lightning = new Lightning()
  private readonly wind: WindModel
  private readonly windUniforms = createWindUniforms()
  private readonly clouds: VolumetricClouds
  private readonly rain: RainEffect
  private readonly skyDome: SkyDome
  private readonly terrainGroup = new Group()
  private readonly shadowGroup = new Group()
  private lastFrameAt = 0
  private introStartedAt: number | null = null
  private disposed = false
  private rendered = false
  private initialized = false
  private width = 1
  private height = 1
  private mobile = false
  private lowPower = false

  static async create(options: LandscapeEngineOptions, signal: AbortSignal) {
    const physicsModule = loadPhysics()
    const prepared =
      options.prepared ??
      (await prepareWorldAsync((options.seed ?? 0) >>> 0, window.innerWidth < 768, signal))
    signal.throwIfAborted()
    const resources = new ResourceScope()
    for (const stage of COMPILE_STAGES) performance.clearMarks(`compile:${stage}`)
    performance.clearMeasures()
    const releaseCompilationScheduler = installCompilationScheduler()
    let engine: LandscapeEngine | undefined
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
      engine = new LandscapeEngine({ ...options, prepared, physics }, resources, scans)
      const initialLight = sampleLighting(
        engine.solarClock.seconds(0),
        0,
        engine.weatherState.levels,
        engine.solar,
      )
      engine.applyLighting(initialLight)
      engine.nightLightFade = initialLight.localLightStrength
      // The offscreen passes do not depend on the lit scene: issue them before
      // the environment so their pipelines compile alongside the scene batch.
      performance.mark('compile:passes')
      passes = compilePasses(engine.compileTargets(), initialLight)
      // Settled with the scene batch; keep an early failure from going unhandled.
      passes.catch(() => undefined)
      // The forest is part of the first frame: wait for the worker's vegetation and add it
      // before the scene compiles, so trees never pop in after the loader has gone.
      await engine.addVegetation(prepared.vegetation, signal)
      performance.mark('compile:environment')
      await compileScene(engine.compileTargets(), signal, passes)
      performance.mark('compile:warmup')
      warmupScene(engine.compileTargets())
      snapshotPrograms(engine.renderer, 'warmup')
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
    options: LandscapeEngineOptions & { prepared: PreparedWorld; physics: PhysicsWorld },
    resources: ResourceScope,
    terrainTextures: TerrainTextures | undefined,
  ) {
    this.resources = resources
    this.terrainTextures = terrainTextures
    const { prepared, physics, ...configuration } = options
    this.options = configuration
    // `create` already owns the physics world in this scope.
    this.physics = physics
    this.state.reducedMotion = options.reducedMotion ?? false
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
          if (this.state.reducedMotion) this.requestFrame()
        },
        this.grade,
      ),
    )
    this.mobile = options.prepared
      ? options.prepared.world.variant === 'mobile'
      : window.innerWidth < 768
    this.lowPower = this.mobile || isLowPowerDevice()
    this.frames = new FrameScheduler(
      this.state,
      this.lowPower,
      () => this.initialized && !this.disposed,
      this.drawFrame,
    )
    this.renderScale =
      debugParams(window.location.search).pixelRatio === undefined
        ? new RenderScaleController(1000 / (this.lowPower ? LOW_POWER_FPS : 60))
        : null
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
    // The season follows the visitor's date and the coordinates' hemisphere, or `?season=`.
    this.season = resolveSeason(params.season, new Date(), params.position.latitude)
    this.life = seasonalLife(this.season)
    this.weatherState = new SceneWeatherState({
      weather: this.weather,
      rain: options.rain ?? DEFAULT_RAIN,
      ...(options.climate?.fog === undefined ? {} : { fog: options.climate.fog }),
      ...(options.climate?.snow === undefined ? {} : { snow: options.climate.snow }),
      ...(options.climate?.temperature === undefined
        ? {}
        : { temperature: options.climate.temperature }),
      ...(options.storm === undefined ? {} : { storm: options.storm }),
      typicalTemperature: this.life.temperature,
    })
    snowCover.value = this.weatherState.snowCover
    this.showSun = true
    this.renderer = options.renderer
    this.renderer.setClearColor(0x080c11)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = PCFShadowMap
    const probe = EnvironmentProbe.allocate(this.renderer, this.lowPower, this.resources)
    this.depthFocus = this.resources.own(new DepthFocus(this.renderer, this.lowPower, this.grade))
    this.renderer.outputColorSpace = SRGBColorSpace
    this.renderer.toneMapping = ACESFilmicToneMapping
    this.renderer.domElement.className = 'block h-full w-full touch-none'
    this.seed = (options.seed ?? 0) >>> 0
    this.renderer.domElement.dataset.seed = String(this.seed)
    this.renderer.domElement.dataset.weather = this.weather
    this.scene.fog = this.fog
    this.scene.background = new Color(0x080c11)
    this.scene.add(this.ambient)
    configureSkyLight(this.moon, this.lowPower, this.resources)
    this.scene.add(this.moon, this.moon.target)

    this.wind = new WindModel((options.seed ?? 0) >>> 0, options.wind)
    this.clouds = this.resources.own(
      new VolumetricClouds(
        this.renderer,
        (options.seed ?? 0) >>> 0,
        this.mobile,
        this.wind,
        (time) =>
          sampleLighting(
            this.solarClock.seconds(time),
            0,
            this.weatherState.levels,
            this.solar,
            this.cloudLight,
          ),
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
    this.skyDome = new SkyDome(
      (options.seed ?? 0) >>> 0,
      this.mobile,
      this.clouds,
      this.skyAtmosphere,
      this.scene,
      this.resources,
    )

    this.shadowGroup.visible = true
    this.scene.add(this.terrainGroup, this.shadowGroup)
    const { lamps, motes } = this.buildWorld(prepared)
    this.lamps = lamps
    this.motes = motes
    this.simulation = this.resources.own(
      new WaterSimulation(this.renderer, this.bed, this.mobile, this.wind, prepared.surfaces.mask),
    )
    this.picker = new ScenePicker({
      canvas: this.renderer.domElement,
      camera: this.camera,
      bed: this.bed,
      physics: this.physics,
      wind: this.wind,
      contact: this.simulation.contact,
      time: () => this.state.elapsed,
    })
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
    const cloudReceivers = prepareLitScene(this.scene)
    for (const material of cloudReceivers) this.receiveSceneLight(material)
    this.details?.attachMaterials(
      this.terrainGroup,
      this.submerged.surfaceMaterials,
      this.submerged.sandMaterial,
    )
    const waterGeometry = this.resources.own(
      createWaterGeometry(this.mobile, prepared.surfaces.water),
    )
    this.water = this.resources.own(
      createLakeReflector(waterGeometry, this.lowPower, {
        wind: this.windUniforms,
        cloud: this.clouds.shadows.uniforms,
        pointer: this.pointerLight.uniforms,
      }),
    )
    const uniforms = this.water.material.uniforms
    mountLake(this.water, {
      renderer: this.renderer,
      camera: this.camera,
      skyMaterial: this.skyDome.material,
      simulation: this.simulation,
      submerged: this.submerged,
      lowPower: this.lowPower,
      setReflectionLayers: (camera) => this.setReflectionLayers(camera),
    })
    this.details?.setWaterImpact(
      (x, z, radius, velocity) => this.simulation.addImpulse(x, z, radius, velocity),
      uniforms,
      this.simulation.contact,
    )
    this.renderer.domElement.dataset.waterMode = this.simulation.available ? 'gpu' : 'analytic'
    placeLake(this.water)
    this.scene.add(this.water)
    this.objects.push(this.water)
    this.scene.add(this.stone.mesh)
    this.scene.add(this.shockwave.mesh)
    this.scene.add(this.lanterns.mesh)
    this.details?.setFireflySeason(this.life.fireflies)
    this.container.dataset.season = this.season.name
    this.wildlife = new LandscapeWildlife({
      scene: this.scene,
      camera: this.camera,
      bed: this.bed,
      picker: this.picker,
      physics: this.physics,
      state: this.state,
      seed: (options.seed ?? 0) >>> 0,
      mobile: this.mobile,
      lowPower: this.lowPower,
      season: this.season,
      life: this.life,
      leafGround: (x, z, fromY) => this.picker.restingPoint(x, z, fromY),
      ripple: (x, z) => this.simulation.addImpulse(x, z, 0.14, -0.05),
      leafWater: (x, z, time, wind, out) => {
        const [height, dx, dz] = this.simulation.contact.sample(x, z, time, wind, 0.1)
        out[0] = height
        out[1] = dx
        out[2] = dz
      },
      leafToWater: (...leaf) => this.details?.catchLeaf(...leaf) ?? false,
    })
    this.receiveSceneLight(this.wildlife.leaves.mesh.material, { translucency: 0.6, gain: 2 })

    this.rain = this.resources.own(
      new RainEffect(
        (a, b) => this.physics.trace(a, b),
        this.lowPower,
        (options.seed ?? 0) >>> 0,
        this.lamps.lights,
        this.moon,
        !!options.reducedMotion,
        uniforms,
        this.simulation.available,
        { ambient: this.ambient, fog: this.fog },
        (x, z) => this.picker.restingPoint(x, z, 24).y,
      ),
    )
    this.rain.setRainState(options.rain ?? DEFAULT_RAIN)
    this.rain.setSnow(this.weatherState.levels.snow)
    this.rain.setWaterContact(this.simulation.contact)
    this.rain.prime()
    if (this.details && this.simulation.available)
      this.rain.setImpactSlopes(this.details.impactSlopes)
    this.scene.add(this.rain.group)
    this.water.material.uniforms.uRainSlopeMap.value = this.rain.texture
    uniforms.uRainSlopesEnabled.value = this.simulation.available ? 1 : 0

    this.camera.position.set(CAMERA_REST.x, CAMERA_REST.y, CAMERA_REST.z)
    this.camera.lookAt(0, this.mobile ? 2.3 : 7.3, -25)

    this.probe = new EnvironmentProbe(
      {
        renderer: this.renderer,
        scene: this.scene,
        water: this.water,
        skyMaterial: this.skyDome.material,
        reflectedSky: this.skyDome.reflected,
        details: this.details,
        filtered: this.simulation.available,
        showSun: this.showSun,
        state: this.state,
      },
      probe,
    )
    this.input = new LandscapeInput({
      canvas: this.renderer.domElement,
      camera: this.camera,
      picker: this.picker,
      state: this.state,
      physics: this.physics,
      simulation: this.simulation,
      wind: this.wind,
      shockwave: this.shockwave,
      stone: this.stone,
      scrub: this.scrub,
      lanterns: this.lanterns,
      details: this.details,
      isOpenWater: (x, z) => this.isOpenWater(x, z),
      requestFrame: () => this.requestFrame(),
      startleCrown: () => this.wildlife.flocks.startle(),
      wishOnStar: () => this.wishOnStar(),
      onShockwave: options.onShockwave,
      onStoneTouchdown: options.onStoneTouchdown,
    })
    this.flare = new SunFlare({
      camera: this.camera,
      physics: this.physics,
      picker: this.picker,
      depthFocus: this.depthFocus,
      state: this.state,
    })
    this.cursor = new CursorEffects(
      {
        picker: this.picker,
        input: this.input,
        state: this.state,
        pointerLight: this.pointerLight,
        waterfall: this.waterfall,
        details: this.details,
        cursorTrace: this.clouds.cursorTrace,
        rain: this.rain,
      },
      UMBRELLA_RADIUS,
    )
    this.weatherView = new WeatherView({
      weather: this.weatherState,
      clouds: this.clouds,
      rain: this.rain,
      atmosphere: this.atmosphere,
      fog: this.fog,
      skyMaterial: this.skyDome.material,
      wind: this.wind,
      state: this.state,
      onRainingChange: () => this.resizeReflection(),
    })
    this.ambience = new AmbientReport(
      this.camera,
      this.waterfall,
      this.season.winter,
      options.onEnvironment,
    )
    this.passes = new FramePasses({
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      diagnostics: this.renderDiagnostics,
      simulation: this.simulation,
      water: this.water,
      rain: this.rain,
      moon: this.moon,
      lamps: this.lamps,
      probe: this.probe,
      submerged: this.submerged,
      depthFocus: this.depthFocus,
      atmosphere: this.atmosphere,
      sceneContrast: this.sceneContrast,
      picker: this.picker,
      state: this.state,
    })
    this.resize()
    this.resources.own({ dispose: () => this.removeListeners() })
    this.input.addListeners()
    window.addEventListener('blur', this.onActivityChange)
    window.addEventListener('focus', this.onActivityChange)
    document.addEventListener('visibilitychange', this.onActivityChange)
    if (this.lowPower && !this.state.reducedMotion) this.tilt.start()
    this.lastFrameAt = performance.now()
  }

  /** The terrain, its shadow casters, the lanterns, the night motes and the detail layer. */
  private buildWorld(prepared: PreparedWorld) {
    const { world, terrain } = prepared
    buildTerrainMeshes(terrain, this.terrainSky, this.terrainTextures, {
      resources: this.resources,
      objects: this.objects,
      terrainGroup: this.terrainGroup,
      shadowGroup: this.shadowGroup,
    })

    const host = {
      scene: this.scene,
      resources: this.resources,
      objects: this.objects,
      lowPower: this.lowPower,
    }
    const lamps = new LanternSystem(world.lamps, host)
    // The forest joins before the first frame; see `addVegetation`.
    this.vegetationGroup.name = 'Vegetation'
    this.scene.add(this.vegetationGroup)
    const motes = new NightMotes(world.seed, this.mobile, host)
    if (this.options.sceneDetails !== false)
      this.details = this.resources.own(
        new SceneDetails(
          this.scene,
          world,
          this.mobile,
          this.state.reducedMotion ?? false,
          this.physics,
          this.options.detailEnvironment,
        ),
      )
    this.details?.setFloaterCamera(this.camera.position)
    const listener = this.options.onWaterSound
    if (listener)
      this.details?.setSoundHandler((kind, x, z, energy) => {
        if (this.disposed) return
        const place = placeSound(this.camera, x, z, this.soundPosition)
        listener({ kind, intensity: energy * place.attenuation * this.state.intro, pan: place.pan })
      })
    return { lamps, motes }
  }

  setReducedMotion(value: boolean) {
    if (this.disposed || value === this.state.reducedMotion) return
    const now = performance.now()
    this.solarClock = new SolarClock(
      this.solarClock.seconds(this.solarClock.elapsed(now)),
      value,
      now,
      this.solarClock.timeScale,
    )
    this.state.reducedMotion = value
    this.wildlife.setReducedMotion(value)
    if (value) {
      // A weather refresh still easing in lands at once: a frozen frame holds no half-blend.
      if (this.weatherState.blend.transitioning) {
        this.weatherState.settle(now / 1000)
        this.weatherView.applyLevels()
        this.probe.invalidate()
      }
      this.scrub.reset()
      this.clouds.cursorTrace.clear()
      // A frozen frame must not hold a stone or a flock in mid-air.
      this.stone.cancel()
      this.shockwave.cancel()
      // Frozen time would hold a gust's lean in place.
      this.vegetation?.gusts.clear()
    }
    if (this.lowPower && !value) this.tilt.start()
    this.lastFrameAt = now
    this.frames.cancel()
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
    if (this.state.reducedMotion) this.requestFrame()
  }

  /**
   * A press on the clear night sky, where the pointer ray meets nothing, makes a wish: a few
   * shooting stars fall from that point.
   */
  private wishOnStar() {
    const ray = this.picker.ray
    if (this.state.daylight > 0.05 || levelsCoverSky(this.weatherState.levels)) return
    if (ray.direction.y < 0.03 || this.picker.solidDistance() < Infinity) return
    this.skyDome.stars.wish(this.picker.ndc.x, this.picker.ndc.y)
  }

  /**
   * Lightning in a thunderstorm or very heavy rain: flashes light the clouds and the scene, and
   * each strike's thunder goes to the sound. None under reduced motion, which also spares
   * photosensitive visitors any flash.
   */
  private updateLightning() {
    const stormy =
      !this.state.reducedMotion &&
      this.state.intro === 1 &&
      (this.weatherState.storm || this.rain.simulation.state.intensity >= LIGHTNING.stormRain)
    const flash = this.lightning.update(this.state.elapsed, stormy, this.options.onThunder)
    this.skyDome.material.uniforms.uFlash.value = flash
    return flash
  }

  private isOpenWater(x: number, z: number) {
    return isOpenWater(this.bed, x, z)
  }

  private requestFrame() {
    this.frames.request()
  }

  private drawFrame = (now: number) => {
    const sampleStart = this.renderDiagnostics.frameStart(now)
    const presented = now - this.lastFrameAt,
      measured = this.rendered && this.state.focused && !this.state.reducedMotion
    const started = performance.now()
    try {
      this.render(now)
      if (measured) this.adaptRenderScale(now, presented, performance.now() - started)
    } catch (error) {
      console.warn('Landscape rendering failed:', error)
      this.options.onContextFailure()
      this.dispose()
    } finally {
      this.renderDiagnostics.frameEnd(sampleStart)
    }
  }

  /** Feeds a presented frame to the dynamic resolution and applies what it decides. */
  private adaptRenderScale(now: number, interval: number, cpuMs: number) {
    const controller = this.renderScale
    if (!controller?.sample(now, interval, cpuMs)) return
    if (controller.degraded && !this.reducedBudget) {
      this.reducedBudget = true
      this.renderer.domElement.dataset.renderBudget = 'reduced'
      // The pixel budget changes the canvas itself; resize also applies the scale.
      this.resize()
    } else this.resizeScene()
  }

  private onActivityChange = () => {
    this.state.focused = document.hasFocus()
    this.input.leave()
    this.frames.cancel()
    this.lastFrameAt = performance.now()
    this.frames.nextFrameAt = this.state.focused ? 0 : this.lastFrameAt + 1000 / 12
    this.probe.invalidate()
    this.renderScale?.reset()
    // requestFrame also handles hidden pages and the final unlit reduced-motion frame.
    this.requestFrame()
  }

  /**
   * A refreshed weather (`watchSceneWeather`): the scene eases toward it over a minute, through
   * uniforms only (see `weather-blend.ts`); reduced motion applies it at once.
   */
  setWeather(weather: SceneWeatherInput) {
    if (this.disposed) return
    this.weather = weather.weather
    this.renderer.domElement.dataset.weather = weather.weather
    this.weatherState.set(
      weather,
      performance.now() / 1000,
      this.state.reducedMotion ? 0 : undefined,
    )
    if (this.state.reducedMotion) {
      this.weatherView.applyLevels()
      this.probe.invalidate()
    }
    this.requestFrame()
  }

  /** Temporary URL parameters only initialize this state; weather may replace it later. */
  setRainState(state: RainState) {
    if (this.disposed) return
    this.rain.setRainState(state)
    this.resizeReflection()
    this.requestFrame()
  }

  private unpublishHooks: (() => void) | undefined

  /** Narrow benchmark hooks; read by page.evaluate, never by the scene itself. */
  private publishDiagnostics() {
    this.unpublishHooks = publishSceneHooks(
      this.renderer,
      this.renderDiagnostics,
      {
        water: [this.water],
        sky: [this.skyDome.mesh],
        terrain: [this.terrainGroup, this.shadowGroup],
        trees: [this.vegetationGroup],
        ...this.details?.debugGroups,
        rain: [this.rain.group],
        lamps: this.lamps.debugObjects,
        motes: [this.motes.mesh],
      },
      () => this.requestFrame(),
    )
  }

  /** What the compile sequence (`scene-compile.ts`) renders and toggles, as it stands now. */
  private compileTargets(): CompileTargets {
    return {
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      water: this.water,
      reflectedSky: this.skyDome.reflected,
      depthFocus: this.depthFocus,
      atmosphere: this.atmosphere,
      skyAtmosphere: this.skyAtmosphere,
      clouds: this.clouds,
      rain: this.rain,
      sceneContrast: this.sceneContrast,
      simulation: this.simulation,
      submerged: this.submerged,
      fauna: this.wildlife.fauna,
      details: this.details,
      probe: this.probe,
      moon: this.moon,
      lampLights: this.lamps.lights,
      shadowGroup: this.shadowGroup,
      vegetation: this.vegetation ? this.vegetationGroup : null,
      transient: [
        ...this.wildlife.transient,
        this.stone.mesh,
        this.shockwave.mesh,
        this.lanterns.mesh,
      ],
      setReflectionLayers: (camera) => this.setReflectionLayers(camera),
      weatherMayChange: this.options.weatherMayChange,
    }
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
    vegetation.setSeason(this.season)
    this.picker.crowns = data.pick
    this.details?.setLeafSources(data.pick)
    this.wildlife.setForest(data.pick)
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

  private applyLighting(light: LightingState) {
    this.moon.position.copy(light.direction).multiplyScalar(320).add(this.moon.target.position)
    this.moon.intensity = light.intensity
    this.moon.color.copy(light.color)
    this.ambient.color.copy(light.ambient)
    this.terrainSky.update(light.ambient)
    this.ambient.intensity = 1
    this.fog.color.copy(light.haze)
    this.fog.density = Math.sqrt(this.weatherState.levels.extinction / 100)
    updateSkyLighting(this.skyDome.material, light, this.showSun)
    this.flare.update(light, this.weatherState.levels.fog, this.showSun)
  }

  private render = (now: number) => {
    if (this.disposed || document.hidden) return
    if (!this.state.reducedMotion) this.requestFrame()
    const activeDelta = Math.max(0, (now - this.lastFrameAt) / 1000)
    const rainDelta = Math.min(activeDelta, 0.1)
    const dt = Math.min(rainDelta, 0.05)
    this.lastFrameAt = now
    if (!this.state.reducedMotion) this.state.elapsed += dt
    if (this.introStartedAt === null) {
      this.introStartedAt = now
      this.solarClock = this.solarClock.restartIntro(now)
    }
    this.state.intro = this.state.reducedMotion
      ? 1
      : clamp((now - this.introStartedAt) / 2200, 0, 1)

    const atmosphereTime = this.solarClock.elapsed(now)
    this.scrub.update(rainDelta, now / 1000)
    const solarSeconds = this.solarClock.seconds(atmosphereTime) + this.scrub.offset
    this.weatherView.update(now, rainDelta)
    const light = sampleLighting(
      wrapDay(solarSeconds),
      0,
      this.weatherState.levels,
      this.solar,
      this.light,
    )
    const host = this.lightingHost
    if (host) {
      const enabled = String(light.localLightStrength > 0)
      if (host.dataset.localLights !== enabled) host.dataset.localLights = enabled
      // DOM fallback; the GPU glyph mask adapts independently at every pixel.
      host.dataset.sceneTone ??= light.ambientLuminance > 0.16 ? 'light' : 'dark'
    }

    const parallax = this.state.reducedMotion ? 0 : 1 - Math.exp(-dt * 2.8)
    if (this.tilt.active) this.input.target.x = this.tilt.value
    const idleDrift =
      this.state.reducedMotion || this.tilt.active
        ? 0
        : Math.sin(this.state.elapsed * 0.17) * CAMERA_IDLE_DRIFT
    easeCamera(this.camera, this.pointer, this.input.target, parallax, idleDrift, this.mobile)
    this.input.moveGrabbedFloater()
    const pointerOnScene =
      this.input.active && this.picker.project(this.input.client.x, this.input.client.y)
    const waterPoint =
      pointerOnScene && this.input.grabPointerId < 0
        ? this.picker.waterOnRay(this.frameWaterPoint)
        : null
    // Snapshot before processPointer() reprojects pending events into the same scratch vector.
    if (pointerOnScene) this.detailPointerNdc.copy(this.picker.ndc)
    if (waterPoint)
      this.input.waterTarget.set(waterPoint.x, waterPoint.z, light.pointerLightStrength)
    else this.input.waterTarget.z = 0
    const contact = this.cursor.updatePointerLight(
      pointerOnScene,
      waterPoint,
      light.pointerLightStrength,
      dt,
    )
    this.input.updateGusts(pointerOnScene, activeDelta, this.vegetation?.gusts)
    // A cursor held still at night gathers the fireflies a little above what it points at.
    const gather =
      contact &&
      light.pointerLightStrength > 0.3 &&
      !this.input.primaryMouseDown &&
      now - this.input.stillSince > FIREFLY_GATHER_DELAY * 1000
        ? this.gatherPoint.copy(contact).setY(contact.y + 0.9)
        : null
    this.cursor.update(pointerOnScene, waterPoint, dt, activeDelta)
    this.input.pump()
    const uniforms = this.water.material.uniforms
    this.applyLighting(light)
    this.skyAtmosphere.update(light.sunDirection, light.skyExposure)
    this.skyDome.advanceStars(
      activeDelta,
      light.sunDirection.y,
      levelsCoverSky(this.weatherState.levels),
      this.state,
      this.camera,
    )
    lightLake(
      this.water,
      light,
      this.weatherState.levels.diffuse,
      this.rain.simulation.state.intensity,
    )
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
    let look = sampled
    if (flash > 0) {
      look = Object.assign(this.flashLook, sampled)
      this.flashLook.exposure = sampled.exposure * (1 + flash * (1.1 - 0.8 * light.daylight))
    }
    this.fog.density = this.baseFogDensity * (1 + morningMist * 1.4) * Math.sqrt(look.haze)
    this.atmosphere.update(light, look)
    this.weatherView.applyFog(light)
    if (!this.state.reducedMotion) this.gradeFrame++
    this.grade.update(look, this.gradeFrame)
    uniforms.uBedInverseViewProjection.value.copy(this.submerged.inverseViewProjection)
    uniforms.uBedViewProjection.value.copy(this.submerged.viewProjection)
    const wind = this.wind.sample(this.state.elapsed)
    const ambientFrame = (this.ambientFrame ??= {
      now,
      solarSeconds,
      daylight: 0,
      wind,
      rainIntensity: 0,
      intro: 0,
    })
    ambientFrame.now = now
    ambientFrame.solarSeconds = solarSeconds
    ambientFrame.daylight = light.daylight
    ambientFrame.wind = wind
    ambientFrame.rainIntensity = this.rain.simulation.state.intensity
    ambientFrame.intro = this.state.intro
    this.ambience.update(ambientFrame)
    updateWindUniforms(this.windUniforms, wind)
    this.vegetation?.update(this.state.elapsed, wind.direction, wind.speed, light)
    if (!this.state.reducedMotion && this.vegetation)
      this.wildlife.leaves.update(
        this.state.elapsed,
        rainDelta,
        wind,
        this.vegetation.breeze,
        this.vegetation.gusts,
      )
    const optics = sampleWaterOptics(
      this.rain.simulation.state.intensity,
      wind.speed,
      this.weatherState.levels.diffuse,
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
      const canvasBounds = this.picker.canvasBounds()
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
    this.input.updateGestures(wind, light.daylight, now / 1000)
    this.state.daylight = light.daylight
    this.wildlife.flocks.update(rainDelta, this.rain.simulation.state.intensity)
    const wildlifeFrame = (this.wildlifeFrame ??= {
      dt,
      solarSeconds,
      solar: this.solar,
      light,
      windSpeed: 0,
      rain: 0,
      weather: this.weatherState,
    })
    wildlifeFrame.dt = dt
    wildlifeFrame.solarSeconds = solarSeconds
    wildlifeFrame.light = light
    wildlifeFrame.windSpeed = wind.speed
    wildlifeFrame.rain = this.rain.simulation.state.intensity
    const wildlife = this.wildlife.updateFauna(wildlifeFrame)
    if (this.container.dataset.wildlife !== wildlife) this.container.dataset.wildlife = wildlife
    if (
      !this.input.demoThrown &&
      !this.input.interacted &&
      !this.state.reducedMotion &&
      this.introStartedAt !== null
    )
      if (now - this.introStartedAt > DEMO_DELAY * 1000) this.input.throwDemo()
    const bait = this.input.baitStrength()
    this.details?.update(
      this.state.elapsed,
      dt,
      wind,
      waterPoint,
      fireflyPointer,
      light.moonIntensity,
      this.state.intro,
      light.pointerLightStrength,
      bait,
      gather,
    )
    const wake = this.details?.rayWake
    if (wake) {
      uniforms.uWake.value.set(wake.x, wake.z, wake.hx, wake.hz)
      uniforms.uWakeSpeed.value = wake.speed
    }
    this.submerged.update(this.state.elapsed)
    this.clouds.update(atmosphereTime)
    this.skyDome.material.uniforms.uTime.value = this.state.elapsed
    this.water.material.uniforms.uTime.value = this.state.elapsed
    pointLake(
      this.water,
      this.input.waterTarget,
      light.pointerLightStrength,
      dt,
      this.state.reducedMotion,
    )
    this.nightLightFade = fadeNightLight(
      this.nightLightFade,
      light.localLightStrength,
      dt,
      this.state.reducedMotion,
    )
    this.lamps.update(this.state, this.nightLightFade, this.weatherState.levels.fog, this.camera)
    this.motes.update(this.state, this.nightLightFade)
    this.passes.stepWater(dt)

    this.rain.update(
      this.state.reducedMotion ? 0 : rainDelta,
      this.camera,
      smoothstep(0, 0.62, this.state.intro),
      this.surfaceFrame(wind),
    )
    const passFrame = (this.passFrame ??= {
      now,
      atmosphereTime,
      sunDirection: light.sunDirection,
      flash: 0,
      probeInterval: 60,
      nightLightFade: 0,
    })
    passFrame.now = now
    passFrame.atmosphereTime = atmosphereTime
    passFrame.sunDirection = light.sunDirection
    passFrame.flash = flash
    // One probe face per interval; the sweep restarts at once after a clock jump.
    passFrame.probeInterval = this.state.focused
      ? this.lowPower || this.reducedBudget
        ? 200
        : 90
      : 60
    passFrame.nightLightFade = this.nightLightFade
    this.passes.render(passFrame)
    if (!this.rendered) {
      this.rendered = true
      this.renderer.domElement.dataset.sceneRendered = 'true'
      performance.mark('landscape-presented')
      this.options.onFirstFrame()
    }
  }

  /** The rain's view of the lake surface this frame, in a reused object. */
  private surfaceFrame(wind: WindState): RainSurfaceFrame {
    const surface = (this.rainSurface ??= { time: 0, wind, push: this.snowPush })
    surface.time = this.state.elapsed
    surface.wind = wind
    surface.gust = this.wind.centreSpeed > 0 ? wind.speed / this.wind.centreSpeed : 1
    return surface
  }

  resize = () => {
    if (this.disposed) return
    // The canvas is fixed fullscreen; its rect only changes with the viewport.
    this.picker.bounds = this.renderer.domElement.getBoundingClientRect()
    const bounds = this.container.getBoundingClientRect()
    this.width = Math.max(1, bounds.width)
    this.height = Math.max(1, bounds.height)
    this.input.size.width = this.width
    this.input.size.height = this.height
    this.camera.aspect = this.width / this.height
    this.camera.updateProjectionMatrix()
    const reduced = this.lowPower || this.reducedBudget
    this.renderer.setPixelRatio(canvasPixelRatio(reduced))
    this.budgetScale = budgetScale(reduced, this.width, this.height)
    this.renderer.setSize(this.width, this.height, false)
    this.renderer.getDrawingBufferSize(this.drawingBufferSize)
    this.rain.resize(this.drawingBufferSize.x, this.drawingBufferSize.y)
    this.resizeScene(false)
    this.grade.resize(this.drawingBufferSize.x, this.drawingBufferSize.y)
    this.sceneContrast.invalidate()
    this.submerged.resize(this.lowPower, this.drawingBufferSize.x, this.drawingBufferSize.y)
    this.water.material.uniforms.uBedTexel.value.copy(this.submerged.bedTexel)
    this.resizeReflection()
    if (this.state.reducedMotion && this.rendered) this.requestFrame()
  }

  /**
   * Sizes the scene's own targets (view, air, mirror) at the dynamic render scale; the lens
   * upsamples the view onto the full drawing buffer. Steps are quantized and rare, so the
   * reallocation they cost does not recur.
   */
  private resizeScene(reflection = true) {
    const scale = this.sceneScale()
    const size = this.sceneBufferSize.set(
      Math.max(1, Math.round(this.drawingBufferSize.x * scale)),
      Math.max(1, Math.round(this.drawingBufferSize.y * scale)),
    )
    this.depthFocus.resize(size.x, size.y, this.width, this.height)
    this.atmosphere.resize(size.x, size.y)
    if (reflection) this.resizeReflection()
    const label = scale.toFixed(2)
    if (this.renderer.domElement.dataset.renderScale !== label)
      this.renderer.domElement.dataset.renderScale = label
  }

  private resizeReflection() {
    const rain = this.rain.raining
    const reduced = this.lowPower || this.reducedBudget
    const scale = reduced ? (rain ? 0.5 : 0.36) : rain ? 0.78 : 0.62
    const detailed = rain && !reduced
    const reflectionScale = Math.min(
      scale,
      (detailed ? 1536 : reduced ? 768 : 1024) / this.drawingBufferSize.x,
      (detailed ? 1080 : reduced ? 832 : 960) / this.drawingBufferSize.y,
    )
    this.water.reflectorNode.reflector.resolutionScale = reflectionScale * this.sceneScale()
  }

  /** The scene's share of the canvas resolution: pixel budget times dynamic render scale. */
  private sceneScale() {
    return this.budgetScale * (this.renderScale?.scale ?? 1)
  }

  private removeListeners() {
    this.input.removeListeners()
    window.removeEventListener('blur', this.onActivityChange)
    window.removeEventListener('focus', this.onActivityChange)
    document.removeEventListener('visibilitychange', this.onActivityChange)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.input.dispose()
    this.stone.mesh.removeFromParent()
    this.stone.dispose()
    this.shockwave.mesh.removeFromParent()
    this.shockwave.dispose()
    this.lanterns.mesh.removeFromParent()
    this.lanterns.dispose()
    this.wildlife.dispose()
    if (this.unpublishHooks) this.unpublishHooks()
    else this.renderDiagnostics.dispose()
    this.unpublishHooks = undefined
    this.frames.cancel()
    this.removeListeners()
    this.tilt.dispose()
    for (const object of this.objects) {
      object.removeFromParent()
      if (object instanceof InstancedMesh) object.dispose()
    }
    this.scene.environment = null
    this.probe.dispose()
    this.resources.dispose()
    const host = this.lightingHost
    if (host) {
      delete host.dataset.localLights
      delete host.dataset.sceneTone
    }
    delete this.renderer.domElement.dataset.renderScale
    delete this.renderer.domElement.dataset.renderBudget
  }
}
