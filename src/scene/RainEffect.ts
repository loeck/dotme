import {
  Color,
  CustomBlending,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  OneFactor,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
} from 'three'
import type {
  IUniform,
  Object3D,
  DirectionalLight,
  PerspectiveCamera,
  PointLight,
  Texture,
  WebGLRenderer,
} from 'three'

import {
  CROWN_FRAGMENT,
  CROWN_VERTEX,
  RAIN_FRAGMENT,
  RAIN_VERTEX,
  RAIN_EXPOSURE,
  RAIN_CROWN_LIFETIME,
  RAIN_SPRAY_LIFETIME,
  SLOPE_FRAGMENT,
  SLOPE_VERTEX,
} from './rain-shaders'
import { IMPACT_LIFETIME, RainCollider, RainSimulation, WATER_Y } from './rain-simulation'
import type { RainImpact, RainState } from './rain-simulation'
import type { VoxelIndex } from './voxel-spatial'
import type { Voxel } from './voxel-world'
import { sampleWindField } from './water-surface'
import type { WindState } from './wind'

/** Relative kinetic energy: volume scales with diameter cubed. */
const impactEnergy = (impact: RainImpact) =>
  Math.min(1, (impact.size / 0.004) ** 3 * (impact.vy / 9) ** 2)

/** Layer 2 is reflected by the lake and drawn after the lens; layer 1 belongs to the bed. */
export const RAIN_LAYER = 2

function instancedPlane(capacity: number, firstName: string, secondName: string, segments = 1) {
  const plane = new PlaneGeometry(1, 1, segments, 1)
  const geometry = new InstancedBufferGeometry()
  geometry.setIndex(plane.index!.clone())
  geometry.setAttribute('position', plane.getAttribute('position').clone())
  geometry.setAttribute('uv', plane.getAttribute('uv').clone())
  plane.dispose()
  const first = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(
    DynamicDrawUsage,
  )
  const second = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(
    DynamicDrawUsage,
  )
  geometry.setAttribute(firstName, first)
  geometry.setAttribute(secondName, second)
  geometry.instanceCount = 0
  return { geometry, first, second, attributes: [first, second] }
}

/** Rain is independent of weather; the only control input is setRainState(). */
export class RainEffect {
  readonly group = new Group()
  readonly simulation: RainSimulation
  private readonly slopes = new Scene()
  private readonly slopeTarget = new WebGLRenderTarget(1, 1, {
    type: HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
  })
  private readonly drops
  private readonly contactAges: InstancedBufferAttribute
  private readonly waves
  private readonly crowns
  private readonly spray
  private readonly particleMaterials: ShaderMaterial[]
  private readonly uniforms
  private readonly slopeMaterial: ShaderMaterial
  private readonly clearColor = new Color()
  private bufferHeight = 1
  private readonly renderResolution = new Vector2(1, 1)
  private readonly viewport = new Vector4()
  private readonly lampPositions: Vector3[]
  private readonly lampColors: Color[]
  private readonly moonColor = new Color()
  private readonly moonDirection = new Vector3()
  private readonly splashLimit: number
  private slopeDirty = true
  private impactSlopes?: Object3D
  private impactsWereVisible = false
  private surfaceTimeOffset = 0
  private surfaceWind?: WindState
  private readonly sampleSurface = (x: number, z: number, time: number) =>
    WATER_Y + sampleWindField(x, z, time + this.surfaceTimeOffset, this.surfaceWind)[0]

  constructor(
    voxels: readonly Voxel[] | VoxelIndex,
    mobile: boolean,
    seed: number,
    private readonly lamps: readonly PointLight[],
    private readonly moon: DirectionalLight,
    private readonly reducedMotion: boolean,
    surfaceUniforms: Record<string, IUniform>,
    slopesSupported: boolean,
  ) {
    this.simulation = new RainSimulation(new RainCollider(voxels), mobile, seed)
    this.splashLimit = mobile ? 48 : 128
    this.drops = instancedPlane(this.simulation.drops.length, 'aDrop', 'aVelocity')
    this.contactAges = new InstancedBufferAttribute(
      new Float32Array(this.simulation.drops.length),
      1,
    ).setUsage(DynamicDrawUsage)
    this.drops.geometry.setAttribute('aContactAge', this.contactAges)
    this.drops.attributes.push(this.contactAges)
    this.waves = instancedPlane(this.simulation.impacts.length, 'aImpact', 'aArrival')
    this.crowns = instancedPlane(this.splashLimit, 'aImpact', 'aArrival', 28)
    this.spray = instancedPlane(this.splashLimit * 3, 'aDrop', 'aVelocity')
    this.lampPositions = Array.from({ length: Math.max(1, lamps.length) }, () => new Vector3())
    this.lampColors = Array.from({ length: Math.max(1, lamps.length) }, () => new Color(0))
    const surface = Object.fromEntries(
      [
        'uTime',
        'uState',
        'uMask',
        'uCell',
        'uWindRotation',
        'uWindRotationVelocity',
        'uWindResponse',
      ].map((key) => [key, surfaceUniforms[key]!]),
    )
    this.uniforms = {
      ...surface,
      uResolution: { value: this.renderResolution },
      uPixelRatio: { value: 1 },
      uMoonColor: { value: this.moonColor },
      uMoonDirection: { value: this.moonDirection },
      uLampPosition: { value: this.lampPositions },
      uLampColor: { value: this.lampColors },
      uDepth: { value: null as Texture | null },
      uOverlay: { value: false },
      uReflectionPass: { value: false },
      uOpacity: { value: 1 },
    }
    this.slopeMaterial = new ShaderMaterial({
      name: 'RainScreenSlopes',
      vertexShader: SLOPE_VERTEX,
      fragmentShader: SLOPE_FRAGMENT,
      uniforms: surface,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: DoubleSide,
      forceSinglePass: true,
      // Explicit ONE + ONE preserves signed slope contributions in the half-float target.
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      toneMapped: false,
    })
    // Shared lighting/occlusion uniforms, with one material per particle shape.
    this.particleMaterials = [
      {
        name: 'RainStreaks',
        geometry: this.drops.geometry,
        vertexShader: RAIN_VERTEX,
        fragmentShader: RAIN_FRAGMENT,
        spray: false,
      },
      {
        name: 'RainCrowns',
        geometry: this.crowns.geometry,
        vertexShader: CROWN_VERTEX,
        fragmentShader: CROWN_FRAGMENT,
        spray: false,
      },
      {
        name: 'RainSpray',
        geometry: this.spray.geometry,
        vertexShader: RAIN_VERTEX,
        fragmentShader: RAIN_FRAGMENT,
        spray: true,
      },
    ].map(({ geometry, spray, ...shader }) => {
      const material = new ShaderMaterial({
        ...shader,
        uniforms: this.uniforms,
        defines: { LAMP_COUNT: this.lampPositions.length, ...(spray ? { SURFACE_SPRAY: 1 } : {}) },
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        forceSinglePass: true,
      })
      const mesh = new Mesh(geometry, material)
      mesh.frustumCulled = false
      mesh.layers.set(RAIN_LAYER)
      mesh.onBeforeRender = (renderer) => {
        // Reconstruct in the active pass's pixels, including the smaller mirror target.
        this.uniforms.uReflectionPass.value = !this.uniforms.uOverlay.value
        renderer.getCurrentViewport(this.viewport)
        this.renderResolution.set(this.viewport.z, this.viewport.w)
        this.uniforms.uPixelRatio.value =
          (renderer.getPixelRatio() * this.viewport.w) / this.bufferHeight
        material.uniformsNeedUpdate = true
      }
      this.group.add(mesh)
      return material
    })
    const waveMesh = new Mesh(this.waves.geometry, this.slopeMaterial)
    waveMesh.frustumCulled = false
    waveMesh.visible = slopesSupported
    if (!slopesSupported) this.slopeTarget.texture.type = UnsignedByteType
    this.slopes.add(waveMesh)
    this.slopeTarget.texture.name = 'Rain screen-space world slopes'
  }

  setImpactSlopes(mesh: Object3D) {
    this.impactSlopes = mesh
    this.slopes.add(mesh)
  }

  get texture() {
    return this.slopeTarget.texture
  }

  setRainState(state: RainState) {
    this.simulation.setRainState(state)
    this.group.visible = !this.reducedMotion && this.simulation.state.intensity > 0
    this.slopeDirty = true
    if (!this.group.visible) {
      this.drops.geometry.instanceCount = 0
      this.waves.geometry.instanceCount = 0
      this.crowns.geometry.instanceCount = 0
      this.spray.geometry.instanceCount = 0
    }
  }

  prime() {
    if (!this.reducedMotion) this.simulation.prime()
  }

  resize(width: number, height: number) {
    this.bufferHeight = height
    this.renderResolution.set(width, height)
    this.slopeTarget.setSize(width, height)
    this.slopeDirty = true
  }

  update(
    delta: number,
    camera: PerspectiveCamera,
    opacity: number,
    surface?: { time: number; wind: WindState },
  ) {
    if (!this.group.visible) return
    if (surface) {
      this.surfaceTimeOffset =
        surface.time - (this.simulation.elapsedTime + Math.max(0, Math.min(delta, 0.1)))
      this.surfaceWind = surface.wind
      this.simulation.setWaterSurface(this.sampleSurface)
    }
    this.simulation.update(delta)
    this.uniforms.uOpacity.value = opacity
    this.moonColor.copy(this.moon.color).multiplyScalar(this.moon.intensity * 1.8)
    this.moonDirection.copy(this.moon.position).sub(this.moon.target.position).normalize()
    this.lamps.forEach((lamp, i) => {
      this.lampPositions[i]!.copy(lamp.position)
      this.lampColors[i]!.copy(lamp.color).multiplyScalar(lamp.intensity * 1.6)
    })
    let count = 0
    for (const drop of this.simulation.drops) {
      if (!drop.alive) continue
      this.drops.first.setXYZW(count, drop.x, drop.y, drop.z, drop.size)
      this.contactAges.setX(count, -1)
      this.drops.second.setXYZW(count++, drop.vx, drop.vy, drop.vz, drop.seed)
    }
    let waveCount = 0
    let crownCount = 0
    let sprayCount = 0
    let splashCount = 0
    for (const impact of this.simulation.impacts) {
      const age = this.simulation.time - impact.born
      if (age < 0 || age >= IMPACT_LIFETIME) continue
      // Retain the final, shortening exposure segment for the frame of contact.
      // Its head is exactly at the collision, so the incoming streak joins its ripple.
      if (age < RAIN_EXPOSURE && count < this.simulation.drops.length) {
        this.drops.first.setXYZW(count, impact.x, impact.y, impact.z, impact.size)
        this.contactAges.setX(count, age)
        this.drops.second.setXYZW(count++, impact.vx, impact.vy, impact.vz, impact.seed)
      }
      const energy = impactEnergy(impact)
      this.writeImpact(this.waves, waveCount++, impact, age, energy)
      const distance = Math.hypot(impact.x - camera.position.x, impact.z - camera.position.z)
      if (
        age > RAIN_SPRAY_LIFETIME ||
        energy < 0.28 ||
        impact.seed > energy ||
        distance > 42 ||
        splashCount >= this.splashLimit
      )
        continue
      splashCount++
      if (age < RAIN_CROWN_LIFETIME)
        this.writeImpact(this.crowns, crownCount++, impact, age, energy)
      for (let i = 0; i < 1 + Math.floor(energy * 2); i++) {
        const angle = impact.seed * 31 + i * 2.399963
        const speed = 0.07 + energy * 0.18
        const vx = Math.cos(angle) * speed + impact.vx * 0.12
        const vz = Math.sin(angle) * speed + impact.vz * 0.12
        const vy = 0.3 + energy * 0.45 + Math.sin(i * 3 + impact.seed) * 0.07
        const y = WATER_Y + vy * age - 4.905 * age * age
        if (y <= WATER_Y) continue
        this.spray.first.setXYZW(
          sprayCount,
          impact.x + vx * age,
          y,
          impact.z + vz * age,
          impact.size * 0.28,
        )
        this.spray.second.setXYZW(sprayCount++, vx, vy - 9.81 * age, vz, impact.seed + i * 0.1)
      }
    }
    this.upload(this.drops, count)
    this.upload(this.waves, waveCount)
    this.upload(this.crowns, crownCount)
    this.upload(this.spray, sprayCount)
    this.slopeDirty = true
  }

  private writeImpact(
    batch: ReturnType<typeof instancedPlane>,
    i: number,
    impact: RainImpact,
    age: number,
    energy: number,
  ) {
    batch.first.setXYZW(i, impact.x, impact.z, age, impact.size)
    batch.second.setXYZW(i, impact.vx, impact.vz, impact.seed, energy)
  }

  private upload(batch: ReturnType<typeof instancedPlane>, count: number) {
    batch.geometry.instanceCount = count
    for (const attribute of batch.attributes) {
      attribute.clearUpdateRanges()
      if (count) attribute.addUpdateRange(0, count * attribute.itemSize)
      attribute.needsUpdate = true
    }
  }

  renderSlopes(renderer: WebGLRenderer, camera: PerspectiveCamera, lakeTime: number) {
    if (!this.slopeDirty && !this.impactSlopes?.visible && !this.impactsWereVisible) return
    const previousTarget = renderer.getRenderTarget()
    renderer.getClearColor(this.clearColor)
    const alpha = renderer.getClearAlpha()
    const autoClear = renderer.autoClear
    this.slopeMaterial.uniforms.uTime!.value = lakeTime
    try {
      renderer.setRenderTarget(this.slopeTarget)
      renderer.setClearColor(0, 0)
      renderer.autoClear = true
      renderer.render(this.slopes, camera)
    } finally {
      renderer.setRenderTarget(previousTarget)
      renderer.setClearColor(this.clearColor, alpha)
      renderer.autoClear = autoClear
    }
    this.slopeDirty = false
    this.impactsWereVisible = this.impactSlopes?.visible ?? false
  }

  /** Composite after surface DOF, depth-testing against the opaque scene explicitly. */
  renderOverlay(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, depth: Texture) {
    if (!this.group.visible) return
    const layers = camera.layers.mask
    const background = scene.background
    const autoClear = renderer.autoClear
    this.uniforms.uDepth.value = depth
    this.uniforms.uOverlay.value = true
    for (const material of this.particleMaterials) material.depthTest = false
    try {
      camera.layers.set(RAIN_LAYER)
      scene.background = null
      renderer.autoClear = false
      renderer.render(scene, camera)
    } finally {
      camera.layers.mask = layers
      scene.background = background
      renderer.autoClear = autoClear
      this.uniforms.uOverlay.value = false
      for (const material of this.particleMaterials) material.depthTest = true
    }
  }

  dispose() {
    this.group.removeFromParent()
    for (const batch of [this.drops, this.waves, this.crowns, this.spray]) batch.geometry.dispose()
    for (const material of this.particleMaterials) material.dispose()
    this.slopeMaterial.dispose()
    this.slopeTarget.dispose()
  }
}
