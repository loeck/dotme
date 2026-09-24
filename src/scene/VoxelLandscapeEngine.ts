import { attribute, exp, mat4, positionGeometry, shadow, uniform, uv, vec4 } from 'three/tsl'
import {
  AdditiveBlending,
  AmbientLight,
  BackSide,
  BoxGeometry,
  Box3,
  Camera,
  Sphere,
  BufferAttribute,
  BufferGeometry,
  Color,
  CubeCamera,
  DirectionalLight,
  DoubleSide,
  FogExp2,
  Group,
  HalfFloatType,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InstancedMesh,
  InterleavedBufferAttribute,
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
  ReinhardToneMapping,
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
import { waterfallSound } from '../audio/environment'
import { sceneParams } from '../scene-params'
import { installCompilationScheduler } from './compilation-scheduler'
import { compileWithoutCulling } from './compile-scene'
import { DepthFocus } from './depth-focus'
import { LOW_POWER_FPS, isLowPowerDevice, maxPixelRatio } from './device-profile'
import { DeviceTilt } from './device-tilt'
import { LAKE_BOUNDS, WATER_LEVEL, lakeIndex } from './lake-bed'
import type { LakeBed } from './lake-bed'
import { FISH_LAYER } from './lake-fish'
import { createLakeReflector } from './lake-water'
import type { LakeReflector } from './lake-water'
import { fadeNightLight, sampleLighting } from './lighting'
import type { LightingState } from './lighting'
import { PointerLight } from './pointer-light'
import { prepareWorldAsync } from './prepare-world'
import type { PreparedWorld } from './prepare-world'
import { DEFAULT_RAIN } from './rain-simulation'
import type { RainState } from './rain-simulation'
import { RAIN_LAYER, RainEffect } from './RainEffect'
import { RenderDiagnostics } from './render-diagnostics'
import { ResourceScope } from './resource-scope'
import { SceneContrast } from './scene-contrast'
import { SceneDetails } from './scene-details'
import type { DetailEnvironment } from './scene-details'
import { createSkyMaterial, updateSkyLighting } from './sky-material'
import { SolarClock, parseInitialTime } from './solar-clock'
import { SPLASH_IMPACT_LAYER } from './splash-impacts'
import { ShootingStars } from './stars'
import { SubmergedScene } from './submerged-scene'
import { VolumetricClouds } from './volumetric-clouds'
import { VolumetricLight } from './volumetric-light'
import { firstVoxelHit } from './voxel-spatial'
import type { VoxelIndex } from './voxel-spatial'
import type { VoxelLamp, VoxelMaterial, VoxelWaterfall } from './voxel-world'
import { sampleWaterOptics } from './water-optics'
import { waterStroke } from './water-pointer'
import { WaterSimulation } from './water-simulation'
import { createWaterGeometry, swellHeight } from './water-surface'
import { WATERFALL_FLUID_LAYER } from './waterfall-fluid'
import { WEATHER } from './weather'
import type { WeatherPreset } from './weather'
import { WindModel, updateWindUniforms } from './wind'
import type { WindOptions } from './wind'
import { createWindUniforms } from './wind-nodes'

export type VoxelLandscapeEngineOptions = Readonly<{
  container: HTMLDivElement
  renderer: WebGPURenderer
  onContextFailure: () => void
  onFirstFrame: () => void
  onEnvironment?: (state: AmbientEnvironment) => void
  reducedMotion?: boolean
  seed?: number
  /** Disable only the optional detail layer for controlled visual/performance comparisons. */
  sceneDetails?: boolean
  detailEnvironment?: Partial<DetailEnvironment>
  diagnostics?: boolean
  prepared?: PreparedWorld
  rain?: RainState
  weather?: WeatherPreset
  wind?: WindOptions
}>

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const smooth = (a: number, b: number, value: number) => {
  const t = clamp((value - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

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

export class VoxelLandscapeEngine {
  private readonly options: Omit<VoxelLandscapeEngineOptions, 'prepared'>
  private readonly container: HTMLDivElement
  private readonly renderer: WebGPURenderer
  private readonly diagnostics: RenderDiagnostics | undefined
  private readonly depthFocus: DepthFocus
  private readonly atmosphere: VolumetricLight
  private readonly sceneContrast: SceneContrast
  private readonly waterfall: VoxelWaterfall | undefined
  private readonly waterfallAudioPosition = new Vector3()
  private solarClock: SolarClock
  private reducedMotion: boolean
  private nightLightFade = 0
  private readonly weather
  private readonly showSun: boolean
  private readonly ambient = new AmbientLight()
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(54, 1, 0.05, 500)
  private readonly raycaster = new Raycaster()
  private readonly rayNdc = new Vector2()
  private readonly waterPlane = new Plane(new Vector3(0, 1, 0), -WATER_LEVEL)
  private readonly waterHit = new Vector3()
  private readonly pointerLight = new PointerLight()
  private readonly lightHit = new Vector3()
  private readonly pointer = new Vector2(0, 0)
  private readonly pointerClient = new Vector2(-1, -1)
  private readonly detailPointerNdc = new Vector2()
  private readonly target = new Vector2(0, 0)
  private readonly tilt = new DeviceTilt()
  private lampShadowCursor = 0
  private moonShadowAt = -Infinity
  private readonly waterPointerTarget = new Vector3(0, 0, 0)
  private readonly objects: Object3D[] = []
  private readonly materials: Array<{ dispose: () => void }> = []
  private readonly geometries: Array<{ dispose: () => void }> = []
  private readonly lampLights: Array<{
    source: VoxelLamp
    light: PointLight
    cube: Mesh<BoxGeometry, MeshBasicNodeMaterial>
    glow: Mesh<PlaneGeometry, MeshBasicNodeMaterial>
    color: Color
    glowStrength: { value: number }
  }> = []
  private readonly motes: Mote[] = []
  private moteMesh: InstancedMesh<BoxGeometry, MeshBasicNodeMaterial> | null = null
  private readonly moteTransform = new Object3D()
  private readonly moon = new DirectionalLight(0xa3bfd6, 1.5)
  private readonly environmentTarget: CubeRenderTarget
  private readonly environmentCamera: CubeCamera
  private readonly environmentFilter: PMREMGenerator
  private filteredEnvironment: RenderTarget | undefined
  private readonly drawingBufferSize = new Vector2()
  private readonly water: LakeReflector
  private readonly simulation: WaterSimulation
  private readonly submerged: SubmergedScene
  private readonly bed: LakeBed
  private details: SceneDetails | undefined
  private detailEnvironment: Partial<DetailEnvironment> = {}
  private readonly voxelIndex: VoxelIndex
  private pointerBounds: DOMRect | null = null
  private pointerActive = false
  private pointerType = 'mouse'
  private pointerHeight = 0
  private pointerRevision = 0
  private pointerBusy = false
  private pendingPointer: { x: number; y: number; time: number } | null = null
  private previousPointer: { x: number; y: number; time: number } | null = null
  private readonly wind: WindModel
  private readonly windUniforms = createWindUniforms()
  private readonly clouds: VolumetricClouds
  private readonly rain: RainEffect
  private readonly shootingStars: ShootingStars
  private starTime = 0
  private ambientStateAt = -Infinity
  private readonly skyMaterial: ReturnType<typeof createSkyMaterial>
  private readonly sky: Mesh<SphereGeometry, ReturnType<typeof createSkyMaterial>>
  private readonly voxelGroup = new Group()
  private readonly shadowGroup = new Group()
  private frame = 0
  private frameTimer = 0
  private nextFrameAt = 0
  private focused = document.hasFocus()
  private environmentAt = -Infinity
  private environmentTime = -Infinity
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
    const prepared =
      options.prepared ??
      (await prepareWorldAsync((options.seed ?? 0) >>> 0, window.innerWidth < 768, signal))
    signal.throwIfAborted()
    const resources = new ResourceScope()
    const releaseCompilationScheduler = installCompilationScheduler()
    let engine: VoxelLandscapeEngine | undefined
    const abort = () => {
      engine?.dispose()
      resources.dispose()
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      // Let the loader present between CPU preparation and material compilation.
      await preparationFrame(signal)
      signal.throwIfAborted()
      engine = new VoxelLandscapeEngine({ ...options, prepared }, resources)
      const initialLight = sampleLighting(engine.solarClock.initialSeconds, 0, engine.weather)
      engine.applyLighting(initialLight)
      engine.nightLightFade = initialLight.localLightStrength
      for (const lamp of engine.lampLights) lamp.light.visible = initialLight.localLightStrength > 0
      await engine.clouds.compileAsync()
      await preparationFrame(signal)
      await engine.compileRain()
      await preparationFrame(signal)
      await engine.sceneContrast.compileAsync(options.renderer)
      await preparationFrame(signal)
      await engine.simulation.compileAsync()
      signal.throwIfAborted()
      await preparationFrame(signal)
      await engine.details?.prepareFluid(options.renderer, engine.camera)
      signal.throwIfAborted()
      await preparationFrame(signal)
      await engine.prepareEnvironment(signal)
      await engine.submerged.compileAsync(options.renderer, engine.scene, engine.camera)
      signal.throwIfAborted()
      await engine.compileView(engine.camera, engine.depthFocus.target)
      await preparationFrame(signal)
      await engine.atmosphere.compileAsync(engine.depthFocus.target, engine.camera, engine.moon)
      await preparationFrame(signal)
      await engine.depthFocus.compileAsync(options.renderer, engine.camera)
      await preparationFrame(signal)
      const reflected = engine.water.getReflectionCamera(engine.camera)
      reflected.copy(engine.camera)
      reflected.layers.enable(RAIN_LAYER)
      engine.water.visible = false
      try {
        await engine.compileView(reflected, engine.water.getRenderTarget(reflected))
      } finally {
        engine.water.visible = true
      }
      await preparationFrame(signal)
      signal.throwIfAborted()
      engine.warmupScene()
      await preparationFrame(signal)
      signal.throwIfAborted()
      engine.initialized = true
      engine.lastFrameAt = performance.now()
      engine.requestFrame()
      return engine
    } catch (error) {
      engine?.dispose()
      resources.dispose()
      throw error
    } finally {
      releaseCompilationScheduler()
      signal.removeEventListener('abort', abort)
    }
  }

  private readonly resources: ResourceScope

  private constructor(
    options: VoxelLandscapeEngineOptions & { prepared: PreparedWorld },
    resources: ResourceScope,
  ) {
    this.resources = resources
    const { prepared, ...configuration } = options
    this.options = configuration
    this.reducedMotion = options.reducedMotion ?? false
    this.bed = options.prepared.world.lakeBed
    this.waterfall =
      options.sceneDetails === false ? undefined : (options.prepared.world.waterfall ?? undefined)
    this.voxelIndex = options.prepared.terrain.index
    this.detailEnvironment = { ...options.detailEnvironment }
    this.container = options.container
    this.sceneContrast = this.resources.own(
      new SceneContrast(this.container.closest('main'), () => {
        if (this.reducedMotion) this.requestFrame()
      }),
    )
    this.mobile = options.prepared
      ? options.prepared.world.variant === 'mobile'
      : window.innerWidth < 768
    this.lowPower = this.mobile || isLowPowerDevice()
    const params = sceneParams(window.location.search)
    this.solarClock = new SolarClock(
      parseInitialTime(params.startTime ?? null),
      options.reducedMotion,
      performance.now(),
      params.timeScale,
    )
    this.weather = options.weather ?? 'partly-cloudy'
    this.showSun = true
    this.renderer = options.renderer
    this.diagnostics = options.diagnostics
      ? this.resources.own(new RenderDiagnostics(this.renderer))
      : undefined
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
    this.environmentCamera.position.set(0, 3, -18)
    this.depthFocus = this.resources.own(new DepthFocus(this.renderer, this.lowPower))
    this.renderer.outputColorSpace = SRGBColorSpace
    this.renderer.toneMapping = ReinhardToneMapping
    this.renderer.domElement.className = 'block h-full w-full touch-none'
    this.renderer.domElement.dataset.seed = String((options.seed ?? 0) >>> 0)
    this.renderer.domElement.dataset.weather = this.weather
    this.renderer.domElement.dataset.generatorVersion = 'voxel-landscape-v1'
    this.scene.fog = new FogExp2(0x14202a, 0.009)
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
    this.scene.add(this.moon, this.moon.target)

    this.wind = new WindModel((options.seed ?? 0) >>> 0, options.wind)
    this.clouds = this.resources.own(
      new VolumetricClouds(
        this.renderer,
        (options.seed ?? 0) >>> 0,
        this.mobile,
        this.wind,
        (time) => sampleLighting(this.solarClock.seconds(time), 0, this.weather),
        this.weather,
        prepared.noise,
        this.lowPower,
      ),
    )
    this.clouds.shadows.applyToLight(this.moon)
    this.atmosphere = this.resources.own(
      new VolumetricLight(
        this.renderer,
        this.lowPower,
        this.clouds.shadows.uniforms,
        WEATHER[this.weather].extinction,
      ),
    )
    this.shootingStars = new ShootingStars((options.seed ?? 0) >>> 0)
    this.skyMaterial = this.resources.own(
      createSkyMaterial((options.seed ?? 0) >>> 0, this.mobile, this.clouds),
    )
    const skyGeometry = new SphereGeometry(260, 32, 16)
    this.sky = new Mesh(skyGeometry, this.skyMaterial)
    this.sky.frustumCulled = false
    this.scene.add(this.sky)
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
    this.submerged = this.resources.own(
      new SubmergedScene(
        this.scene,
        this.bed,
        this.simulation.available,
        prepared.surfaces.submerged,
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
    for (const material of cloudReceivers) {
      this.clouds.shadows.applyTo(material, this.camera)
      this.pointerLight.applyTo(material)
    }
    this.details?.attachMaterials(this.voxelGroup, this.submerged.surfaceMaterials)
    const waterGeometry = createWaterGeometry(this.mobile, prepared.surfaces.water)
    this.water = this.resources.own(
      createLakeReflector(waterGeometry, this.mobile, this.simulation.available, {
        wind: this.windUniforms,
        cloud: this.clouds.shadows.uniforms,
        pointer: this.pointerLight.uniforms,
      }),
    )
    const reflectedCamera = this.water.getReflectionCamera(this.camera)
    this.water.getRenderTarget(reflectedCamera).texture.anisotropy = Math.min(
      this.lowPower ? 4 : 8,
      this.renderer.getMaxAnisotropy(),
    )
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
    )
    this.renderer.domElement.dataset.waterMode = this.simulation.available ? 'gpu' : 'analytic'
    this.water.rotation.x = -Math.PI / 2
    this.water.position.y = WATER_LEVEL
    this.water.updateMatrixWorld(true)
    this.water.matrixAutoUpdate = this.water.matrixWorldAutoUpdate = false
    this.water.receiveShadow = true
    this.scene.add(this.water)
    this.objects.push(this.water)
    this.geometries.push(waterGeometry)

    this.rain = this.resources.own(
      new RainEffect(
        prepared.terrain.index,
        this.lowPower,
        (options.seed ?? 0) >>> 0,
        this.lampLights.map(({ light }) => light),
        this.moon,
        !!options.reducedMotion,
        uniforms,
        this.simulation.available,
      ),
    )
    this.rain.setRainState(options.rain ?? DEFAULT_RAIN)
    this.rain.prime()
    if (this.details && this.simulation.available)
      this.rain.setImpactSlopes(this.details.impactSlopes)
    this.scene.add(this.rain.group)
    this.water.getReflectionCamera(this.camera).layers.enable(RAIN_LAYER)
    this.water.material.uniforms.uRainSlopeMap.value = this.rain.texture
    uniforms.uRainSlopesEnabled.value = this.simulation.available ? 1 : 0

    this.camera.position.set(0, 2.3, 16)
    this.camera.lookAt(0, this.mobile ? 2.3 : 7.3, -25)

    this.resize()
    this.resources.own({ dispose: () => this.removeListeners() })
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointermove', this.onPointerMove, { passive: true })
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerUp)
    this.renderer.domElement.addEventListener('pointerleave', this.onPointerLeave)
    this.renderer.domElement.addEventListener('lostpointercapture', this.onLostCapture)
    window.addEventListener('blur', this.onActivityChange)
    window.addEventListener('focus', this.onActivityChange)
    document.addEventListener('visibilitychange', this.onActivityChange)
    if (this.lowPower && !this.reducedMotion) this.tilt.start()
    this.lastFrameAt = performance.now()
  }

  private measure<T>(name: string, action: () => T): T {
    return this.diagnostics ? this.diagnostics.measure(name, action) : action()
  }

  getDiagnostics() {
    return this.diagnostics?.snapshot() ?? null
  }

  private buildWorld(prepared: PreparedWorld) {
    const { world, terrain } = prepared
    const seed = world.seed
    const surfaces: Record<VoxelMaterial, { roughness: number; metalness: number }> = {
      ground: { roughness: 0.88, metalness: 0 },
      shore: { roughness: 0.24, metalness: 0.04 },
      rock: { roughness: 0.42, metalness: 0.02 },
    }
    for (const kind of ['ground', 'shore', 'rock'] as const) {
      const material = new MeshStandardNodeMaterial({
        ...surfaces[kind],
        envMapIntensity: 0.8,
        flatShading: true,
        vertexColors: true,
      })
      this.materials.push(this.resources.own(material))
      for (const batch of terrain.batches) {
        if (batch.material !== kind) continue
        const geometry = new BufferGeometry()
        geometry.setAttribute('position', new BufferAttribute(batch.positions, 3))
        geometry.setAttribute('normal', new BufferAttribute(batch.normals, 3, true))
        geometry.setAttribute('color', new BufferAttribute(batch.colors, 3))
        geometry.setIndex(new BufferAttribute(batch.indices, 1))
        geometry.boundingBox = new Box3(
          new Vector3().fromArray(batch.bounds.min),
          new Vector3().fromArray(batch.bounds.max),
        )
        geometry.boundingSphere = new Sphere(
          new Vector3().fromArray(batch.bounds.center),
          batch.bounds.radius,
        )
        const mesh = new Mesh(geometry, material)
        mesh.receiveShadow = true
        mesh.updateMatrixWorld(true)
        mesh.matrixAutoUpdate = mesh.matrixWorldAutoUpdate = false
        this.voxelGroup.add(mesh)
        this.objects.push(mesh)
        this.geometries.push(this.resources.own(geometry))
      }
    }

    this.buildShadowCasters(terrain)

    const capGeometry = new BoxGeometry(0.17, 0.17, 0.17)
    const glowGeometry = new PlaneGeometry(1.3, 1.3)
    this.geometries.push(this.resources.own(capGeometry), this.resources.own(glowGeometry))
    world.lamps.forEach((lamp) => {
      const cap = new Mesh(
        capGeometry,
        new MeshBasicNodeMaterial({
          color: 0xb4d9f5,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      )
      cap.position.set(lamp.x, lamp.y, lamp.z)
      this.scene.add(cap)
      this.objects.push(cap)
      this.materials.push(this.resources.own(cap.material))
      const light = new PointLight(0xa5d4ee, 22 * lamp.intensity, 8, 2)
      light.position.copy(cap.position)
      this.configurePointShadow(light)
      this.scene.add(light)
      this.objects.push(light)
      const glowStrength = uniform(0)
      const glowMaterial = new MeshBasicNodeMaterial({
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        side: DoubleSide,
        // Fog would mix the opaque additive quad toward the fog colour and light up its square.
        fog: false,
      })
      const p = uv().sub(0.5).mul(2)
      const r = p.dot(p)
      glowMaterial.fragmentNode = vec4(
        uniform(new Color(0xa5d9ff))
          .mul(
            exp(r.mul(-39))
              .mul(0.76)
              .add(exp(r.mul(-5.5)).mul(0.095)),
          )
          .mul(glowStrength),
        1,
      )
      const glow = new Mesh(glowGeometry, glowMaterial)
      glow.position.copy(cap.position)
      glow.frustumCulled = false
      this.scene.add(glow)
      this.objects.push(glow)
      this.materials.push(this.resources.own(glowMaterial))
      this.lampLights.push({
        source: lamp,
        light,
        cube: cap,
        glow,
        color: cap.material.color.clone(),
        glowStrength,
      })
    })

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
          this.options.detailEnvironment,
        ),
      )
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

  private buildShadowCasters(terrain: PreparedWorld['terrain']) {
    const box = new BoxGeometry(1, 1, 1)
    const material = new MeshBasicNodeMaterial()
    // Vertex attributes share one shader across every batch. Per-mesh matrix
    // buffers otherwise generate unique WGSL names and hundreds of pipelines.
    material.positionNode = mat4(
      attribute('shadowMatrix0', 'vec4'),
      attribute('shadowMatrix1', 'vec4'),
      attribute('shadowMatrix2', 'vec4'),
      attribute('shadowMatrix3', 'vec4'),
    ).mul(vec4(positionGeometry, 1)).xyz
    this.geometries.push(this.resources.own(box))
    this.materials.push(this.resources.own(material))
    for (const [index, matrices] of terrain.shadowMatrices.entries()) {
      const geometry = this.resources.own(new InstancedBufferGeometry())
      geometry.setIndex(box.getIndex())
      for (const [name, buffer] of Object.entries(box.attributes))
        geometry.setAttribute(name, buffer)
      const transforms = new InstancedInterleavedBuffer(matrices, 16)
      for (let column = 0; column < 4; column++)
        geometry.setAttribute(
          `shadowMatrix${column}`,
          new InterleavedBufferAttribute(transforms, 4, column * 4),
        )
      geometry.instanceCount = matrices.length / 16
      const mesh = new Mesh(geometry, material)
      mesh.castShadow = true
      mesh.layers.set(5)
      const bounds = terrain.shadowBounds[index]
      if (!bounds) throw new Error('Missing prepared shadow bounds')
      geometry.boundingBox = new Box3(
        new Vector3().fromArray(bounds.min),
        new Vector3().fromArray(bounds.max),
      )
      geometry.boundingSphere = new Sphere(new Vector3().fromArray(bounds.center), bounds.radius)
      mesh.updateMatrixWorld(true)
      mesh.matrixAutoUpdate = mesh.matrixWorldAutoUpdate = false
      this.shadowGroup.add(mesh)
      this.objects.push(mesh)
    }
  }

  private configurePointShadow(light: PointLight) {
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
    if (document.elementFromPoint(clientX, clientY) !== canvas) return false
    const bounds = this.pointerBounds ?? canvas.getBoundingClientRect()
    const x = ((clientX - bounds.left) / bounds.width) * 2 - 1
    const y = -((clientY - bounds.top) / bounds.height) * 2 + 1
    if (Math.abs(x) > 1 || Math.abs(y) > 1) return false
    this.rayNdc.set(x, y)
    this.raycaster.setFromCamera(this.rayNdc, this.camera)
    return true
  }

  private hitWater(clientX: number, clientY: number): Vector3 | null {
    return this.projectPointer(clientX, clientY) ? this.waterPointOnRay() : null
  }

  private waterPointOnRay(): Vector3 | null {
    const ray = this.raycaster.ray
    this.waterPlane.constant = -WATER_LEVEL
    if (!ray.intersectPlane(this.waterPlane, this.waterHit)) return null
    const wind = this.wind.sample(this.elapsed)
    for (let i = 0; i < 3; i++) {
      this.waterPlane.constant = -(
        WATER_LEVEL +
        this.pointerHeight +
        swellHeight(this.waterHit.x, this.waterHit.z, this.elapsed, wind)
      )
      if (!ray.intersectPlane(this.waterPlane, this.waterHit)) return null
    }
    const distance = this.waterHit.distanceTo(this.camera.position)
    const index = lakeIndex(this.bed, this.waterHit.x, this.waterHit.z)
    if (distance > 130 || index < 0 || !this.bed.water[index]) return null
    // Conservative raster of the actual solids includes the banks and isolated stones.
    const cell = LAKE_BOUNDS.size / this.bed.resolution
    for (let d = 0; d < distance - 0.05; d += cell * 0.5) {
      const px = ray.origin.x + ray.direction.x * d
      const pz = ray.origin.z + ray.direction.z * d
      const i = lakeIndex(this.bed, px, pz)
      if (i >= 0 && (this.bed.obstacle[i] ?? -Infinity) >= ray.origin.y + ray.direction.y * d)
        return null
    }
    return this.waterHit.clone()
  }

  private updatePointerLight(
    pointerOnScene: boolean,
    waterPoint: Vector3 | null,
    nightStrength: number,
    dt: number,
  ) {
    let contact = null
    if (nightStrength > 0 && pointerOnScene && this.pointerType === 'mouse' && this.focused) {
      const ray = this.raycaster.ray
      const solid = firstVoxelHit(this.voxelIndex, ray.origin.toArray(), ray.direction.toArray())
      if (solid && (!waterPoint || solid.distance < ray.origin.distanceTo(waterPoint)))
        contact = ray.at(solid.distance, this.lightHit)
      else contact = waterPoint
    }
    this.pointerLight.update(
      contact,
      this.raycaster.ray.direction,
      nightStrength * this.intro,
      dt,
      this.reducedMotion,
    )
  }

  private async processPointer() {
    const event = this.pendingPointer
    if (!event || this.pointerBusy || this.disposed) return
    this.pendingPointer = null
    this.pointerBusy = true
    const revision = this.pointerRevision
    try {
      let point = this.hitWater(event.x, event.y)
      if (!point) {
        this.previousPointer = null
        return
      }
      this.pointerHeight = await this.simulation.heightAt(point.x, point.z)
      if (this.disposed || revision !== this.pointerRevision) return
      point = this.hitWater(event.x, event.y)
      if (!point) {
        this.previousPointer = null
        return
      }
      const previous = this.previousPointer
      if (previous && (event.x !== previous.x || event.y !== previous.y)) {
        // Reproject both client positions with the SAME camera. Parallax is never input energy.
        const start = this.hitWater(previous.x, previous.y)
        if (start) {
          const distance = start.distanceTo(point)
          const pixels = Math.hypot(event.x - previous.x, event.y - previous.y)
          const { samples, radius, velocity } = waterStroke(
            pixels,
            (event.time - previous.time) / 1000,
            distance,
            this.dragging,
          )
          const projected = start.clone()
          const bounds = this.pointerBounds ?? this.renderer.domElement.getBoundingClientRect()
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

  private onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary) return
    this.pointerType = event.pointerType
    this.pointerActive = true
    this.pointerClient.set(event.clientX, event.clientY)
    if (this.reducedMotion) {
      this.requestFrame()
      return
    }
    const point = this.hitWater(event.clientX, event.clientY)
    if (!point) return
    // Queue the contact immediately so a quick touch ending before the next frame still ripples.
    this.simulation.addImpulse(point.x, point.z, 0.7, -0.26)
    this.dragging = true
    this.dragPointerId = event.pointerId
    this.pointerType = event.pointerType
    this.pointerActive = true
    this.pointerClient.set(event.clientX, event.clientY)
    this.previousPointer = { x: event.clientX, y: event.clientY, time: event.timeStamp }
    this.pendingPointer = { x: event.clientX, y: event.clientY, time: event.timeStamp }
    this.renderer.domElement.setPointerCapture(event.pointerId)
  }

  private onPointerMove = (event: PointerEvent) => {
    if (!this.focused || document.hidden) return
    if (!event.isPrimary || (this.dragging && event.pointerId !== this.dragPointerId)) return
    this.pointerType = event.pointerType
    this.pointerActive = event.pointerType !== 'touch' || event.buttons !== 0
    this.target.set(
      clamp((event.clientX / this.width) * 2 - 1, -1, 1),
      clamp((event.clientY / this.height) * 2 - 1, -1, 1),
    )
    if (this.pointerClient.x === event.clientX && this.pointerClient.y === event.clientY) return
    this.pointerClient.set(event.clientX, event.clientY)
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
  }

  private onPointerUp = (event: PointerEvent) => {
    if (!event.isPrimary) return
    if (event.pointerType === 'touch' && event.pointerId !== this.dragPointerId) {
      this.onPointerLeave()
      return
    }
    if (event.pointerId !== this.dragPointerId) return
    this.dragging = false
    this.dragPointerId = -1
    if (event.type === 'pointercancel' || this.pointerType === 'touch') this.onPointerLeave()
    if (this.renderer.domElement.hasPointerCapture(event.pointerId))
      this.renderer.domElement.releasePointerCapture(event.pointerId)
  }

  private onLostCapture = () => {
    if (this.dragging) this.onPointerLeave()
  }

  private onPointerLeave = () => {
    const pointerId = this.dragPointerId
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
    try {
      this.render(now)
    } catch (error) {
      console.warn('Landscape rendering failed:', error)
      this.options.onContextFailure()
      this.dispose()
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
      this.renderer.setRenderTarget(this.depthFocus.target)
      const render = () => this.renderer.render(this.scene, this.camera)
      // A real offscreen pass also prepares ReflectorNode's nested render context.
      // No simulation step runs and the shared canvas continues to contain the loader.
      if (this.details) this.details.warmup(render)
      else render()
    } finally {
      this.renderer.setRenderTarget(target, face, mip)
    }
  }

  private compileRain() {
    const compile = () => this.rain.compileAsync(this.renderer, this.camera)
    return this.details ? this.details.compileAsync(compile) : compile()
  }

  /** Capture render state synchronously: the loader borrows this renderer between yields. */
  private compileView(
    camera: Camera,
    target: RenderTarget | null,
    object: Object3D = this.scene,
    face = 0,
  ) {
    const previous = this.renderer.getRenderTarget()
    const previousFace = this.renderer.getActiveCubeFace(),
      mip = this.renderer.getActiveMipmapLevel()
    try {
      this.renderer.setRenderTarget(target, face)
      const compile = () => this.renderer.compileAsync(object, camera, this.scene)
      return this.details ? this.details.compileAsync(compile) : compile()
    } finally {
      this.renderer.setRenderTarget(previous, previousFace, mip)
    }
  }

  // These passes share one renderer; yield between them instead of competing for its state.
  /* eslint-disable no-await-in-loop */
  private async prepareEnvironment(signal: AbortSignal) {
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
    this.water.visible = false
    try {
      const cubeCamera = this.environmentCamera.children.find((child) => child instanceof Camera)
      if (!cubeCamera) throw new Error('Missing environment cube camera')
      // All six faces use the same lighting, layers and attachment formats. Include
      // off-axis meshes once instead of compiling their cached variants on every face.
      await compileWithoutCulling(this.scene, () =>
        this.compileView(cubeCamera, this.environmentTarget),
      )
      await preparationFrame(signal)
      // The material used by the public shadow node is shared with the actual shadow pass.
      for (const light of [this.moon, ...this.lampLights.map((lamp) => lamp.light)]) {
        const map = light.shadow.map
        if (!light.visible || !map) continue
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
        const material = this.scene.overrideMaterial,
          background = this.scene.background
        let compiled: Promise<void>
        try {
          const shadowMaterial = shadow(light).getShadowMaterial()
          // Shadow rendering flips front-sided casters. Keep that same variant while
          // compileAsync yields, rather than restoring its default front side.
          shadowMaterial.side = BackSide
          this.scene.overrideMaterial = shadowMaterial
          this.scene.background = null
          compiled = this.compileView(light.shadow.camera, map, this.shadowGroup)
        } finally {
          this.scene.overrideMaterial = material
          this.scene.background = background
        }
        await compiled
        await preparationFrame(signal)
      }
    } finally {
      this.water.visible = true
    }
    this.moon.shadow.needsUpdate = true
    for (const lamp of this.lampLights) lamp.light.shadow.needsUpdate = true
    this.updateEnvironment(performance.now(), 0)
    await preparationFrame(signal)
  }

  /* eslint-enable no-await-in-loop */

  private updateEnvironment(now: number, atmosphereTime: number) {
    // Reuse broad indirect lighting; planar water reflections stay per-frame.
    // Intro, still renders and clock discontinuities always refresh the probe.
    const interval = 1000 / (this.focused ? (this.lowPower ? 4 : 15) : 3)
    if (
      now - this.environmentAt < interval &&
      atmosphereTime >= this.environmentTime &&
      atmosphereTime - this.environmentTime <= 1 &&
      this.intro === 1 &&
      !this.reducedMotion
    )
      return

    this.water.visible = false
    const environmentIntensity = this.scene.environmentIntensity
    this.scene.environmentIntensity = 0
    // Direct solar energy already comes from the directional light. Excluding the
    // disc from the lighting probe keeps disc visibility independent of illumination.
    this.skyMaterial.uniforms.uShowSun.value = 0
    this.skyMaterial.uniforms.uShowMoon.value = 0
    try {
      this.measure('environment', () => this.environmentCamera.update(this.renderer, this.scene))
    } finally {
      this.water.visible = true
      this.scene.environmentIntensity = environmentIntensity
      this.skyMaterial.uniforms.uShowSun.value = this.showSun ? 1 : 0
      this.skyMaterial.uniforms.uShowMoon.value = 1
    }
    // Filter explicitly before the main render. Lazy filtering inside a
    // material upload would nest renderer calls and disturb texture bindings.
    if (this.simulation.available) {
      this.filteredEnvironment = this.measure('pmrem', () =>
        this.environmentFilter.fromCubemap(
          this.environmentTarget.texture,
          this.filteredEnvironment,
        ),
      )
      this.scene.environment = this.filteredEnvironment.texture
    }
    this.water.material.uniforms.uEnvironment.value =
      this.filteredEnvironment?.texture ?? this.environmentTarget.texture
    this.environmentAt = now
    this.environmentTime = atmosphereTime
  }

  /** Static casters: low-power devices refresh the slow sun and one moving lamp per frame. */
  private updateShadows(now: number) {
    const throttle = this.lowPower && this.intro === 1 && !this.reducedMotion
    if (!throttle || now - this.moonShadowAt >= 250) {
      this.moon.shadow.needsUpdate = true
      this.moonShadowAt = now
    }
    if (!throttle) {
      for (const lamp of this.lampLights) lamp.light.shadow.needsUpdate = true
      return
    }
    if (!this.lampLights.length) return
    this.lampShadowCursor = (this.lampShadowCursor + 1) % this.lampLights.length
    const lamp = this.lampLights[this.lampShadowCursor]
    if (lamp?.light.visible) lamp.light.shadow.needsUpdate = true
  }

  private applyLighting(light: LightingState) {
    this.moon.position.copy(light.direction).multiplyScalar(320).add(this.moon.target.position)
    this.moon.intensity = light.intensity
    this.moon.color.copy(light.color)
    this.ambient.color.copy(light.ambient)
    this.ambient.intensity = 1
    const fog = this.scene.fog
    if (fog instanceof FogExp2) {
      fog.color.copy(light.haze)
      fog.density = Math.sqrt(WEATHER[this.weather].extinction / 100)
    }
    updateSkyLighting(this.skyMaterial, light, this.showSun)
  }

  private render = (now: number) => {
    if (this.disposed || document.hidden) return
    this.frame = 0
    if (!this.reducedMotion) this.requestFrame()
    this.diagnostics?.begin(now)
    const activeDelta = Math.max(0, (now - this.lastFrameAt) / 1000)
    const rainDelta = Math.min(activeDelta, 0.1)
    const dt = Math.min(rainDelta, 0.05)
    this.lastFrameAt = now
    if (!this.reducedMotion) this.elapsed += dt
    if (this.introStartedAt === null) this.introStartedAt = now
    this.intro = this.reducedMotion ? 1 : clamp((now - this.introStartedAt) / 2200, 0, 1)

    const atmosphereTime = this.solarClock.elapsed(now)
    const light = sampleLighting(this.solarClock.seconds(atmosphereTime), 0, this.weather)
    const lightingHost = this.container.closest('main')
    if (lightingHost) {
      const enabled = String(light.localLightStrength > 0)
      if (lightingHost.dataset.localLights !== enabled) lightingHost.dataset.localLights = enabled
      // DOM fallback; the GPU glyph mask adapts independently at every pixel.
      lightingHost.dataset.sceneTone ??= light.ambientLuminance > 0.16 ? 'light' : 'dark'
    }

    const parallax = this.reducedMotion ? 0 : 1 - Math.exp(-dt * 2.8)
    if (this.tilt.active) this.target.x = this.tilt.value
    this.pointer.lerp(this.target, parallax)
    const idleDrift =
      this.reducedMotion || this.tilt.active ? 0 : Math.sin(this.elapsed * 0.17) * 0.15
    this.camera.position.x += (this.pointer.x * 1.9 + idleDrift - this.camera.position.x) * parallax
    this.camera.position.y += (2.3 + this.pointer.y * -0.16 - this.camera.position.y) * parallax
    this.camera.position.z = 16
    this.camera.lookAt(this.camera.position.x * 0.22, this.mobile ? 2.3 : 7.3, -25)
    this.camera.updateMatrixWorld()
    this.pointerBounds = this.pointerActive
      ? this.renderer.domElement.getBoundingClientRect()
      : null
    const pointerOnScene =
      this.pointerActive && this.projectPointer(this.pointerClient.x, this.pointerClient.y)
    const waterPoint = pointerOnScene ? this.waterPointOnRay() : null
    if (waterPoint)
      this.waterPointerTarget.set(waterPoint.x, waterPoint.z, light.pointerLightStrength)
    else this.waterPointerTarget.z = 0
    this.updatePointerLight(pointerOnScene, waterPoint, light.pointerLightStrength, dt)
    void this.processPointer().catch(() => {
      this.previousPointer = null
    })
    const uniforms = this.water.material.uniforms
    this.applyLighting(light)
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
    uniforms.uNight.value = 1 - light.daylight
    this.atmosphere.update(light)
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
        solarHour: this.solarClock.seconds(atmosphereTime) / 3600,
        daylight: light.daylight,
        windSpeed: wind.speed,
        rainIntensity: this.rain.simulation.state.intensity,
        waterfall,
      })
    }
    updateWindUniforms(this.windUniforms, wind)
    const optics = sampleWaterOptics(this.rain.simulation.state.intensity, wind.speed)
    uniforms.uWaterClarity.value = optics.clarity
    uniforms.uWaterAgitation.value = optics.agitation
    // Airborne colonies follow the cursor's projected proximity. Terrain picking
    // jumps between bank heights and distant water and cannot drive their motion.
    let fireflyPointer = null
    if (
      this.pointerActive &&
      document.elementFromPoint(this.pointerClient.x, this.pointerClient.y) ===
        this.renderer.domElement
    ) {
      const bounds = this.pointerBounds ?? this.renderer.domElement.getBoundingClientRect()
      this.detailPointerNdc.set(
        ((this.pointerClient.x - bounds.left) / bounds.width) * 2 - 1,
        1 - ((this.pointerClient.y - bounds.top) / bounds.height) * 2,
      )
      fireflyPointer = {
        ndc: this.detailPointerNdc,
        camera: this.camera,
        width: bounds.width,
        height: bounds.height,
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
    this.details?.update(
      this.elapsed,
      dt,
      wind,
      waterPoint,
      fireflyPointer,
      light.moonIntensity,
      this.intro,
      light.pointerLightStrength,
    )
    this.pointerBounds = null
    this.measure('clouds', () => this.clouds.update(atmosphereTime))
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
      lamp.cube.visible = lamp.glow.visible = lamp.light.visible = this.nightLightFade > 0
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
      lamp.cube.position.set(
        source.x + Math.sin(this.elapsed * source.speed * 0.73 + source.phase) * sway,
        source.y + drift - descent,
        source.z + Math.cos(this.elapsed * source.speed * 0.61 + source.phase * 1.3) * sway * 0.7,
      )
      lamp.light.position.copy(lamp.cube.position)
      lamp.glow.position.copy(lamp.cube.position)
      lamp.glow.quaternion.copy(this.camera.quaternion)
      lamp.light.intensity = 22 * source.intensity * energy
      lamp.glowStrength.value = 0.58 * energy
      lamp.cube.material.opacity = presence
      lamp.cube.material.color.copy(lamp.color).multiplyScalar(breathing)
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
    if (!this.reducedMotion)
      this.measure('simulation', () => this.simulation.step(dt, this.elapsed))
    uniforms.uState.value = this.simulation.texture

    this.measure('rain-update', () =>
      this.rain.update(
        this.reducedMotion ? 0 : rainDelta,
        this.camera,
        smooth(0, 0.62, this.intro),
        { time: this.elapsed, wind },
      ),
    )
    this.measure('rain-slopes', () =>
      this.rain.renderSlopes(this.renderer, this.camera, this.elapsed),
    )
    this.updateShadows(now)
    this.updateEnvironment(now, atmosphereTime)
    this.measure('lake-bed', () => this.submerged.render(this.renderer, this.scene, this.camera))
    this.depthFocus.render(
      this.renderer,
      this.scene,
      this.camera,
      this.atmosphere,
      this.moon,
      this.diagnostics,
    )
    this.measure('rain', () =>
      this.rain.renderOverlay(this.renderer, this.scene, this.camera, this.depthFocus.depthTexture),
    )
    this.measure('interface', () =>
      this.sceneContrast.render(this.renderer, this.atmosphere.target.texture),
    )
    this.diagnostics?.end()
    if (!this.rendered) {
      this.rendered = true
      this.renderer.domElement.dataset.sceneRendered = 'true'
      performance.mark('landscape-presented')
      this.options.onFirstFrame()
    }
  }

  resize = () => {
    if (this.disposed) return
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
    this.sceneContrast.invalidate()
    this.submerged.resize(this.lowPower, this.drawingBufferSize.x, this.drawingBufferSize.y)
    this.water.material.uniforms.uBedTexel.value.copy(this.submerged.bedTexel)
    this.resizeReflection()
    if (this.reducedMotion && this.rendered) this.requestFrame()
  }

  private resizeReflection() {
    const rain = this.rain.group.visible
    const scale = this.lowPower ? (rain ? 0.5 : 0.36) : rain ? 0.75 : 0.46
    const detailed = rain && !this.lowPower
    const reflectionScale = Math.min(
      scale,
      (detailed ? 1536 : 768) / this.drawingBufferSize.x,
      (detailed ? 1080 : 832) / this.drawingBufferSize.y,
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
    window.removeEventListener('blur', this.onActivityChange)
    window.removeEventListener('focus', this.onActivityChange)
    document.removeEventListener('visibilitychange', this.onActivityChange)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
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
    const lightingHost = this.container.closest('main')
    if (lightingHost) {
      delete lightingHost.dataset.localLights
      delete lightingHost.dataset.sceneTone
    }
  }
}
