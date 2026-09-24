import {
  AdditiveBlending,
  AmbientLight,
  BoxGeometry,
  Color,
  CubeCamera,
  DirectionalLight,
  DoubleSide,
  FogExp2,
  Group,
  HalfFloatType,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
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
  ShaderMaterial,
  SphereGeometry,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLCubeRenderTarget,
  WebGLRenderer,
} from 'three'
import type { WebGLRenderTarget } from 'three'

import { CursorGlow } from './cursor-glow'
import { DepthFocus } from './depth-focus'
import { LAKE_BOUNDS, WATER_LEVEL, lakeIndex } from './lake-bed'
import type { LakeBed } from './lake-bed'
import { createLakeReflector } from './lake-water'
import type { LakeReflector } from './lake-water'
import { sampleMoonLight } from './moon-light'
import { SceneDetails } from './scene-details'
import type { DetailEnvironment } from './scene-details'
import { createSkyMaterial } from './sky-material'
import { SubmergedScene } from './submerged-scene'
import { VolumetricClouds } from './volumetric-clouds'
import type { Voxel, VoxelLamp, VoxelMaterial } from './voxel-world'
import { createVoxelWorld } from './voxel-world'
import { WaterSimulation } from './water-simulation'
import { createWaterGeometry, swellHeight } from './water-surface'
import { WindModel, createWindUniforms, updateWindUniforms } from './wind'

export type VoxelLandscapeEngineOptions = Readonly<{
  container: HTMLDivElement
  onContextFailure: () => void
  onFirstFrame: () => void
  reducedMotion?: boolean
  seed?: number
  /** Disable only the optional detail layer for controlled visual/performance comparisons. */
  sceneDetails?: boolean
  detailEnvironment?: Partial<DetailEnvironment>
}>

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const smooth = (a: number, b: number, value: number) => {
  const t = clamp((value - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

const GLOW_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const GLOW_FRAGMENT = `
uniform vec3 uColor;
uniform float uIntensity;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float r = dot(p, p);
  float core = exp(-r * 39.0) * 0.76;
  float halo = exp(-r * 5.5) * 0.095;
  gl_FragColor = vec4(uColor * (core + halo) * uIntensity, 1.0);
}
`

type Mote = Readonly<{
  x: number
  y: number
  z: number
  size: number
  phase: number
  speed: number
}>

export class VoxelLandscapeEngine {
  private readonly options: VoxelLandscapeEngineOptions
  private readonly container: HTMLDivElement
  private readonly renderer: WebGLRenderer
  private readonly depthFocus: DepthFocus
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(54, 1, 0.05, 500)
  private readonly raycaster = new Raycaster()
  private readonly rayNdc = new Vector2()
  private readonly waterPlane = new Plane(new Vector3(0, 1, 0), -WATER_LEVEL)
  private readonly waterHit = new Vector3()
  private readonly cursorGlow = new CursorGlow()
  private readonly pointer = new Vector2(0, 0)
  private readonly pointerClient = new Vector2(-1, -1)
  private readonly detailPointerNdc = new Vector2()
  private readonly target = new Vector2(0, 0)
  private readonly waterPointerTarget = new Vector3(0, 0, 0)
  private readonly objects: Object3D[] = []
  private readonly materials: Array<{ dispose: () => void }> = []
  private readonly geometries: Array<{ dispose: () => void }> = []
  private readonly lampLights: Array<{
    source: VoxelLamp
    light: PointLight
    cube: Mesh<BoxGeometry, MeshBasicMaterial>
    glow: Mesh<PlaneGeometry, ShaderMaterial>
    color: Color
    glowStrength: { value: number }
  }> = []
  private readonly motes: Mote[] = []
  private moteMesh: InstancedMesh<BoxGeometry, MeshBasicMaterial> | null = null
  private readonly moteTransform = new Object3D()
  private readonly moon = new DirectionalLight(0xa3bfd6, 1.5)
  private readonly environmentTarget: WebGLCubeRenderTarget
  private readonly environmentCamera: CubeCamera
  private readonly environmentFilter: PMREMGenerator
  private filteredEnvironment: WebGLRenderTarget | undefined
  private readonly drawingBufferSize = new Vector2()
  private readonly water: LakeReflector
  private readonly simulation: WaterSimulation
  private readonly submerged: SubmergedScene
  private bed!: LakeBed
  private details: SceneDetails | undefined
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
  private readonly skyMaterial: ShaderMaterial
  private readonly sky: Mesh<SphereGeometry, ShaderMaterial>
  private readonly voxelGroup = new Group()
  private frame = 0
  private lastFrameAt = 0
  private elapsed = 0
  private intro = 0
  private introStartedAt: number | null = null
  private dragging = false
  private dragPointerId = -1
  private disposed = false
  private rendered = false
  private width = 1
  private height = 1
  private mobile = false

  constructor(options: VoxelLandscapeEngineOptions) {
    this.options = options
    this.container = options.container
    this.mobile = window.innerWidth < 768
    this.renderer = new WebGLRenderer({
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
    })
    this.renderer.setClearColor(0x080c11)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = PCFShadowMap
    // Update once per animation frame; all reflection cameras reuse these shadows.
    this.renderer.shadowMap.autoUpdate = false
    this.environmentTarget = new WebGLCubeRenderTarget(this.mobile ? 64 : 128, {
      type: this.renderer.extensions.has('EXT_color_buffer_float')
        ? HalfFloatType
        : UnsignedByteType,
    })
    this.environmentFilter = new PMREMGenerator(this.renderer)
    this.environmentTarget.texture.name = 'Live landscape environment'
    this.environmentCamera = new CubeCamera(0.1, 500, this.environmentTarget)
    this.environmentCamera.position.set(0, 3, -18)
    this.depthFocus = new DepthFocus(this.renderer, this.mobile)
    this.renderer.outputColorSpace = SRGBColorSpace
    this.renderer.toneMapping = ReinhardToneMapping
    this.renderer.domElement.className = 'block h-full w-full touch-none'
    this.renderer.domElement.dataset.seed = String((options.seed ?? 0) >>> 0)
    this.renderer.domElement.dataset.generatorVersion = 'voxel-landscape-v1'
    this.container.append(this.renderer.domElement)
    this.scene.fog = new FogExp2(0x14202a, 0.009)
    this.scene.background = new Color(0x080c11)
    this.scene.add(new AmbientLight(0x526074, 0.38))
    this.moon.position.set(-35, 48, -48)
    this.moon.target.position.set(0, 0, -28)
    this.moon.castShadow = true
    this.moon.shadow.mapSize.setScalar(this.mobile ? 1024 : 2048)
    Object.assign(this.moon.shadow.camera, {
      left: -115,
      right: 115,
      top: 100,
      bottom: -100,
      near: 0.5,
      far: 280,
    })
    this.moon.shadow.camera.updateProjectionMatrix()
    this.moon.shadow.normalBias = 0.12
    this.moon.shadow.bias = -0.00015
    this.scene.add(this.moon, this.moon.target)

    this.wind = new WindModel((options.seed ?? 0) >>> 0)
    this.clouds = new VolumetricClouds(
      this.renderer,
      (options.seed ?? 0) >>> 0,
      this.mobile,
      this.wind,
    )
    this.skyMaterial = createSkyMaterial((options.seed ?? 0) >>> 0, this.mobile, this.clouds)
    const skyGeometry = new SphereGeometry(260, 32, 16)
    this.sky = new Mesh(skyGeometry, this.skyMaterial)
    this.sky.frustumCulled = false
    this.scene.add(this.sky)
    this.materials.push(this.skyMaterial)
    this.geometries.push(skyGeometry)

    this.scene.add(this.voxelGroup)
    this.buildWorld((options.seed ?? 0) >>> 0)
    this.simulation = new WaterSimulation(this.renderer, this.bed, this.mobile, this.wind)
    this.submerged = new SubmergedScene(this.scene, this.bed, this.simulation.available)
    this.scene.traverse((object) => {
      if ('isLight' in object) object.layers.enable(1)
    })
    const cloudReceivers = new Set<MeshStandardMaterial>()
    this.scene.traverse((object) => {
      if (object instanceof Mesh && object.material instanceof MeshStandardMaterial)
        cloudReceivers.add(object.material)
    })
    for (const material of cloudReceivers) this.clouds.shadows.applyTo(material)
    // Add local cursor irradiance after cloud attenuation of the sky fill.
    this.cursorGlow.attachSurfaces(this.scene)
    this.details?.attachMaterials(this.voxelGroup, this.submerged.surfaceMaterials)
    const waterGeometry = createWaterGeometry(this.mobile)
    this.water = createLakeReflector(waterGeometry, this.mobile, this.simulation.available)
    const captureReflection = this.water.onBeforeRender
    this.water.onBeforeRender = (...args) => {
      this.skyMaterial.uniforms.uReflectionCapture!.value = 1
      try {
        captureReflection.apply(this.water, args)
      } finally {
        this.skyMaterial.uniforms.uReflectionCapture!.value = 0
      }
    }
    this.water.getRenderTarget().texture.anisotropy = Math.min(
      this.mobile ? 4 : 8,
      this.renderer.capabilities.getMaxAnisotropy(),
    )
    const uniforms = this.water.material.uniforms
    Object.assign(
      uniforms,
      this.windUniforms,
      this.clouds.shadows.uniforms,
      this.cursorGlow.uniforms,
    )
    uniforms.uState!.value = this.simulation.texture
    uniforms.uMask!.value = this.simulation.mask
    uniforms.uCell!.value = LAKE_BOUNDS.size / this.simulation.resolution
    uniforms.uBedColor!.value = this.submerged.target.texture
    uniforms.uBedDepth!.value = this.submerged.target.depthTexture
    uniforms.uBedHeight!.value = this.submerged.depthField
    uniforms.uShore!.value = this.submerged.shoreField
    this.renderer.domElement.dataset.waterMode = this.simulation.available ? 'gpu' : 'analytic'
    if (!this.simulation.available) this.water.getRenderTarget().texture.type = UnsignedByteType
    this.water.rotation.x = -Math.PI / 2
    this.water.position.y = WATER_LEVEL
    this.water.receiveShadow = true
    this.scene.add(this.water)
    this.objects.push(this.water)
    this.geometries.push(waterGeometry)

    this.camera.position.set(0, 2.3, 16)
    this.camera.lookAt(0, this.mobile ? 2.3 : 7.3, -25)

    this.resize()
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointermove', this.onPointerMove, { passive: true })
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerUp)
    this.renderer.domElement.addEventListener('pointerleave', this.onPointerLeave)
    this.renderer.domElement.addEventListener('lostpointercapture', this.onLostCapture)
    window.addEventListener('blur', this.onPointerLeave)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost)
    this.lastFrameAt = performance.now()
    this.frame = requestAnimationFrame(this.render)
  }

  private buildWorld(seed: number) {
    const world = createVoxelWorld(seed, this.mobile)
    this.bed = world.lakeBed
    const box = new BoxGeometry(1, 1, 1)
    this.geometries.push(box)
    const dummy = new Object3D()
    const color = new Color()
    const surfaces: Record<VoxelMaterial, { roughness: number; metalness: number }> = {
      ground: { roughness: 0.88, metalness: 0 },
      shore: { roughness: 0.24, metalness: 0.04 },
      rock: { roughness: 0.42, metalness: 0.02 },
    }
    let offset = 0
    for (const kind of Object.keys(world.groups) as VoxelMaterial[]) {
      const count = world.groups[kind].count
      if (count === 0) continue
      // Instance colors contain only albedo. Illumination is evaluated by the GPU.
      const material = new MeshStandardMaterial({
        ...surfaces[kind],
        envMapIntensity: 0.8,
        flatShading: true,
      })
      this.materials.push(material)
      // Spatial batches let each point-light face discard distant voxels.
      // One world-sized batch would submit all 50k cubes to every shadow camera.
      const chunks = new Map<string, Voxel[]>()
      for (let i = 0; i < count; i += 1) {
        const voxel = world.voxels[offset + i]!
        const key = `${Math.floor(voxel.x / 12)}:${Math.floor(voxel.z / 12)}`
        let chunk = chunks.get(key)
        if (!chunk) {
          chunk = []
          chunks.set(key, chunk)
        }
        chunk.push(voxel)
      }
      offset += count
      for (const voxels of chunks.values()) {
        const mesh = new InstancedMesh(box, material, voxels.length)
        mesh.castShadow = true
        mesh.receiveShadow = true
        for (const [index, voxel] of voxels.entries()) {
          dummy.position.set(voxel.x, voxel.y, voxel.z)
          dummy.scale.setScalar(voxel.size)
          dummy.updateMatrix()
          mesh.setMatrixAt(index, dummy.matrix)
          mesh.setColorAt(index, color.setHex(voxel.color))
        }
        mesh.instanceMatrix.needsUpdate = true
        mesh.computeBoundingSphere()
        mesh.computeBoundingBox()
        this.voxelGroup.add(mesh)
        this.objects.push(mesh)
      }
    }

    const capGeometry = new BoxGeometry(0.17, 0.17, 0.17)
    const glowGeometry = new PlaneGeometry(1.3, 1.3)
    this.geometries.push(capGeometry, glowGeometry)
    world.lamps.forEach((lamp) => {
      const cap = new Mesh(capGeometry, new MeshBasicMaterial({ color: 0xb4d9f5 }))
      cap.position.set(lamp.x, lamp.y, lamp.z)
      this.scene.add(cap)
      this.objects.push(cap)
      this.materials.push(cap.material)
      const light = new PointLight(0xa5d4ee, 22 * lamp.intensity, 8, 2)
      light.position.copy(cap.position)
      this.configurePointShadow(light)
      this.scene.add(light)
      this.objects.push(light)
      const glowStrength = { value: 0 }
      const glowMaterial = new ShaderMaterial({
        vertexShader: GLOW_VERTEX,
        fragmentShader: GLOW_FRAGMENT,
        uniforms: {
          uColor: { value: new Color(0xa5d9ff) },
          uIntensity: glowStrength,
        },
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        side: DoubleSide,
      })
      const glow = new Mesh(glowGeometry, glowMaterial)
      glow.position.copy(cap.position)
      glow.frustumCulled = false
      this.scene.add(glow)
      this.objects.push(glow)
      this.materials.push(glowMaterial)
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
    const moteMaterial = new MeshBasicMaterial({
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
    this.geometries.push(moteGeometry)
    this.materials.push(moteMaterial)
    if (this.options.sceneDetails !== false)
      this.details = new SceneDetails(
        this.scene,
        world,
        this.mobile,
        this.options.reducedMotion ?? false,
        this.options.detailEnvironment,
      )
  }

  /** Feed the shared rain/solar state into the details; safe before or after the first frame. */
  setDetailEnvironment(environment: Partial<DetailEnvironment>) {
    if (this.disposed) return
    this.details?.setEnvironment(environment)
    if (this.options.reducedMotion && this.frame === 0)
      this.frame = requestAnimationFrame(this.render)
  }

  private configurePointShadow(light: PointLight) {
    light.castShadow = true
    light.shadow.mapSize.setScalar(this.mobile ? 256 : 512)
    light.shadow.camera.near = 0.08
    light.shadow.camera.far = light.distance || 30
    light.shadow.bias = -0.001
    light.shadow.normalBias = 0.035
  }

  private hitWater(clientX: number, clientY: number, throughOverlay = false): Vector3 | null {
    const canvas = this.renderer.domElement
    if (!throughOverlay && document.elementFromPoint(clientX, clientY) !== canvas) return null
    const bounds = canvas.getBoundingClientRect()
    const x = ((clientX - bounds.left) / bounds.width) * 2 - 1
    const y = -((clientY - bounds.top) / bounds.height) * 2 + 1
    if (Math.abs(x) > 1 || Math.abs(y) > 1) return null
    this.rayNdc.set(x, y)
    this.raycaster.setFromCamera(this.rayNdc, this.camera)
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
      if (i >= 0 && this.bed.obstacle[i]! >= ray.origin.y + ray.direction.y * d) return null
    }
    return this.waterHit.clone()
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
          const seconds = Math.max(0.008, (event.time - previous.time) / 1000)
          const speed = Math.min(25, distance / seconds)
          const samples = Math.min(48, Math.ceil(distance / 0.22))
          for (let i = 1; i <= samples; i++) {
            const t = i / samples
            // Screen-space samples are visibility checked; a long stroke cannot cross a bank.
            const contact = this.hitWater(
              previous.x + (event.x - previous.x) * t,
              previous.y + (event.y - previous.y) * t,
            )
            if (contact)
              this.simulation.addImpulse(
                contact.x,
                contact.z,
                this.dragging ? 0.48 : 0.36,
                -Math.min(0.45, 0.018 + speed * 0.018) *
                  (this.dragging ? 1.5 : 0.55) *
                  Math.min(1, distance / Math.max(1, samples) / 0.22),
              )
          }
        }
      }
      this.previousPointer = event
    } finally {
      this.pointerBusy = false
    }
  }

  private updateCursorGlow(waterPoint: Vector3 | null): boolean {
    if (!this.pointerActive) return false
    const bounds = this.renderer.domElement.getBoundingClientRect()
    if (
      this.pointerClient.x < bounds.left ||
      this.pointerClient.x > bounds.right ||
      this.pointerClient.y < bounds.top ||
      this.pointerClient.y > bounds.bottom
    )
      return false
    // Transparent profile overlays must not hide the scene from the light picker.
    // Water gestures still require direct contact with the canvas.
    waterPoint ??= this.hitWater(this.pointerClient.x, this.pointerClient.y, true)
    // hitWater has projected the cursor with this frame's camera.
    // Test actual solid faces as well as water, including cliff faces and isolated rocks.
    this.raycaster.far = 130
    const candidates = this.voxelGroup.children.filter((child) => {
      const mesh = child as InstancedMesh
      return mesh.boundingBox && this.raycaster.ray.intersectsBox(mesh.boundingBox)
    })
    const solid = this.raycaster.intersectObjects(candidates, false)[0]
    const position = this.cursorGlow.uniforms.uCursorGlowPosition.value
    if (solid && (!waterPoint || solid.distance < this.camera.position.distanceTo(waterPoint))) {
      position.copy(solid.point)
    } else if (waterPoint) {
      position.copy(waterPoint)
    } else return false
    // Keep the soft emitter on the visible side of the contact, slightly raised.
    // This gives neighboring voxel faces distinct shading without a spotlight cone.
    const source = this.cursorGlow.uniforms.uCursorGlowSource.value
    source.copy(position).addScaledVector(this.raycaster.ray.direction, -2.4)
    source.y += 0.8
    return true
  }

  private onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary) return
    this.pointerType = event.pointerType
    this.pointerActive = true
    this.pointerClient.set(event.clientX, event.clientY)
    if (this.options.reducedMotion) {
      if (this.frame === 0) this.frame = requestAnimationFrame(this.render)
      return
    }
    const point = this.hitWater(event.clientX, event.clientY)
    if (!point) return
    // Queue the contact immediately so a quick touch ending before the next frame still ripples.
    this.simulation.addImpulse(point.x, point.z, 0.48, -0.4)
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
    if (!event.isPrimary || (this.dragging && event.pointerId !== this.dragPointerId)) return
    this.pointerType = event.pointerType
    this.pointerActive = event.pointerType !== 'touch' || event.buttons !== 0
    this.target.set(
      clamp((event.clientX / this.width) * 2 - 1, -1, 1),
      clamp((event.clientY / this.height) * 2 - 1, -1, 1),
    )
    if (this.pointerClient.x === event.clientX && this.pointerClient.y === event.clientY) return
    this.pointerClient.set(event.clientX, event.clientY)
    if (this.options.reducedMotion) {
      if (this.frame === 0) this.frame = requestAnimationFrame(this.render)
      return
    }
    if (!this.pointerActive || !this.hitWater(event.clientX, event.clientY)) {
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
    if (this.options.reducedMotion && !this.disposed && this.frame === 0)
      this.frame = requestAnimationFrame(this.render)
    if (pointerId >= 0 && this.renderer.domElement.hasPointerCapture(pointerId))
      this.renderer.domElement.releasePointerCapture(pointerId)
  }

  private onVisibilityChange = () => {
    this.onPointerLeave()
    if (document.hidden) return
    this.lastFrameAt = performance.now()
    if (this.options.reducedMotion && this.frame === 0)
      this.frame = requestAnimationFrame(this.render)
  }

  private onContextLost = (event: Event) => {
    event.preventDefault()
    this.options.onContextFailure()
    this.dispose()
  }

  private render = (now: number) => {
    if (this.disposed) return
    if (this.options.reducedMotion) this.frame = 0
    else this.frame = requestAnimationFrame(this.render)
    if (document.hidden) return
    const dt = clamp((now - this.lastFrameAt) / 1000, 0, 0.05)
    this.lastFrameAt = now
    if (!this.options.reducedMotion) this.elapsed += dt
    if (this.introStartedAt === null) this.introStartedAt = now
    this.intro = this.options.reducedMotion ? 1 : clamp((now - this.introStartedAt) / 2200, 0, 1)

    const parallax = this.options.reducedMotion ? 0 : 1 - Math.exp(-dt * 2.8)
    this.pointer.lerp(this.target, parallax)
    const idleDrift = this.options.reducedMotion ? 0 : Math.sin(this.elapsed * 0.17) * 0.15
    this.camera.position.x += (this.pointer.x * 1.9 + idleDrift - this.camera.position.x) * parallax
    this.camera.position.y += (2.3 + this.pointer.y * -0.16 - this.camera.position.y) * parallax
    this.camera.position.z = 16
    this.camera.lookAt(this.camera.position.x * 0.22, this.mobile ? 2.3 : 7.3, -25)
    this.camera.updateMatrixWorld()
    const waterPoint = this.pointerActive
      ? this.hitWater(this.pointerClient.x, this.pointerClient.y)
      : null
    if (waterPoint) this.waterPointerTarget.set(waterPoint.x, waterPoint.z, 1)
    else this.waterPointerTarget.z = 0
    const glowTarget = this.updateCursorGlow(waterPoint) ? 1 : 0
    const cursorStrength = this.cursorGlow.uniforms.uCursorGlowStrength
    cursorStrength.value +=
      (glowTarget - cursorStrength.value) *
      (this.options.reducedMotion ? 1 : 1 - Math.exp(-dt * (glowTarget ? 6 : 4)))
    if (cursorStrength.value < 0.001) cursorStrength.value = 0
    void this.processPointer().catch(() => {
      this.previousPointer = null
    })
    const uniforms = this.water.material.uniforms
    // Slow moon motion changes the grazing light, shadows and reflected sky together.
    const moon = sampleMoonLight(this.elapsed)
    this.moon.position.copy(moon.offset).add(this.moon.target.position)
    this.moon.intensity = moon.intensity
    this.skyMaterial.uniforms.uMoonDirection!.value.copy(moon.offset).normalize()
    this.skyMaterial.uniforms.uMoonIntensity!.value = moon.intensity
    uniforms.uBedInverseViewProjection!.value.copy(this.submerged.inverseViewProjection)
    uniforms.uBedViewProjection!.value.copy(this.submerged.viewProjection)
    const wind = this.wind.sample(this.elapsed)
    updateWindUniforms(this.windUniforms, wind)
    // Airborne colonies follow the cursor's projected proximity. Terrain picking
    // jumps between bank heights and distant water and cannot drive their motion.
    let fireflyPointer = null
    if (
      this.pointerActive &&
      document.elementFromPoint(this.pointerClient.x, this.pointerClient.y) ===
        this.renderer.domElement
    ) {
      const bounds = this.renderer.domElement.getBoundingClientRect()
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
    this.details?.update(
      this.elapsed,
      dt,
      wind,
      waterPoint,
      fireflyPointer,
      moon.intensity,
      this.intro,
    )
    this.clouds.update(this.elapsed)
    this.skyMaterial.uniforms.uTime!.value = this.elapsed
    this.water.material.uniforms.uTime!.value = this.elapsed
    const waterPointer = this.water.material.uniforms.uPointer!.value as Vector3
    // The contact point must stay under the cursor while the camera eases.
    // Only the optical reveal trails off; smoothing x/z makes the surface feel detached.
    waterPointer.x = this.waterPointerTarget.x
    waterPointer.y = this.waterPointerTarget.y
    waterPointer.z +=
      (this.waterPointerTarget.z - waterPointer.z) *
      (this.options.reducedMotion ? 1 : 1 - Math.exp(-dt * 8))
    for (const [index, lamp] of this.lampLights.entries()) {
      const source = lamp.source
      const motion = Math.sin(this.elapsed * source.speed + source.phase)
      // Long, independent quiet intervals separate soft changes tied to the bobbing.
      // A subset stays steady, so the bank never pulses as one synchronized light.
      const active =
        this.options.reducedMotion || source.phase < Math.PI * 0.45
          ? 0
          : smooth(0.15, 0.7, Math.sin(this.elapsed * source.speed * 0.29 + source.phase * 1.7))
      const breathing = 1 + motion * (0.1 + source.amplitude * 0.6) * active
      const energy = smooth(0.12 + index * 0.045, 0.55 + index * 0.045, this.intro) * breathing
      const drift = this.options.reducedMotion ? 0 : motion * source.amplitude
      const sway = this.options.reducedMotion ? 0 : source.driftRadius
      lamp.cube.position.set(
        source.x + Math.sin(this.elapsed * source.speed * 0.73 + source.phase) * sway,
        source.y + drift,
        source.z + Math.cos(this.elapsed * source.speed * 0.61 + source.phase * 1.3) * sway * 0.7,
      )
      lamp.light.position.copy(lamp.cube.position)
      lamp.glow.position.copy(lamp.cube.position)
      lamp.glow.quaternion.copy(this.camera.quaternion)
      lamp.light.intensity = 22 * source.intensity * energy
      lamp.glowStrength.value = 0.58 * energy
      lamp.cube.material.color.copy(lamp.color).multiplyScalar(energy)
    }
    if (this.moteMesh) {
      this.moteMesh.material.opacity = smooth(0.25, 0.9, this.intro) * 0.2
      if (!this.options.reducedMotion) {
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
    if (!this.options.reducedMotion) this.simulation.step(dt, this.elapsed)
    uniforms.uState!.value = this.simulation.texture
    this.renderer.shadowMap.needsUpdate = true
    // Capture current lighting in all six directions every frame. Water has its
    // own planar reflection and is excluded to avoid recursive mirror captures.
    this.water.visible = false
    const environmentIntensity = this.scene.environmentIntensity
    this.scene.environmentIntensity = 0
    try {
      this.environmentCamera.update(this.renderer, this.scene)
    } finally {
      this.water.visible = true
      this.scene.environmentIntensity = environmentIntensity
    }
    // Filter explicitly before the main render. Lazy filtering inside a
    // material upload would nest renderer calls and disturb texture bindings.
    if (this.simulation.available) {
      this.filteredEnvironment = this.environmentFilter.fromCubemap(
        this.environmentTarget.texture,
        this.filteredEnvironment,
      )
      this.scene.environment = this.filteredEnvironment.texture
    }
    this.water.material.uniforms.uEnvironment!.value =
      this.filteredEnvironment?.texture ?? this.environmentTarget.texture
    this.submerged.render(this.renderer, this.scene)
    this.depthFocus.render(this.renderer, this.scene, this.camera)
    if (!this.rendered) {
      this.rendered = true
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
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, this.width < 768 ? 1.5 : 1.75),
    )
    this.renderer.setSize(this.width, this.height, false)
    this.renderer.getDrawingBufferSize(this.drawingBufferSize)
    this.depthFocus.resize(
      this.drawingBufferSize.x,
      this.drawingBufferSize.y,
      this.width,
      this.height,
    )
    this.submerged.resize(this.mobile)
    this.water.material.uniforms.uBedTexel!.value.set(
      1 / this.submerged.target.width,
      1 / this.submerged.target.height,
    )
    const reflectionScale = Math.min(
      this.mobile ? 0.4 : 0.46,
      768 / this.drawingBufferSize.x,
      832 / this.drawingBufferSize.y,
    )
    this.water
      .getRenderTarget()
      .setSize(
        Math.max(256, Math.round(this.drawingBufferSize.x * reflectionScale)),
        Math.max(256, Math.round(this.drawingBufferSize.y * reflectionScale)),
      )
    if (this.options.reducedMotion && this.rendered && this.frame === 0)
      this.frame = requestAnimationFrame(this.render)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.frame)
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown)
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerUp)
    this.renderer.domElement.removeEventListener('pointerleave', this.onPointerLeave)
    this.renderer.domElement.removeEventListener('lostpointercapture', this.onLostCapture)
    window.removeEventListener('blur', this.onPointerLeave)
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    for (const object of this.objects) {
      object.removeFromParent()
      if (object instanceof InstancedMesh) object.dispose()
    }
    this.scene.environment = null
    this.details?.dispose()
    this.clouds.dispose()
    this.environmentTarget.dispose()
    this.filteredEnvironment?.dispose()
    this.environmentFilter.dispose()
    this.moon.shadow.dispose()
    for (const { light } of this.lampLights) light.shadow.dispose()
    this.pointerRevision += 1
    this.simulation.dispose()
    this.submerged.dispose()
    this.water.dispose()
    this.depthFocus.dispose()
    for (const material of this.materials) material.dispose()
    for (const geometry of this.geometries) geometry.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
