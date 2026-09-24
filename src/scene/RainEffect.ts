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
  WebGLRenderTarget,
} from 'three'
import type {
  IUniform,
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
  SLOPE_FRAGMENT,
  SLOPE_VERTEX,
} from './rain-shaders'
import { IMPACT_LIFETIME, RainCollider, RainSimulation, WATER_Y } from './rain-simulation'
import type { RainImpact, RainState } from './rain-simulation'
import type { VoxelIndex } from './voxel-spatial'
import type { Voxel } from './voxel-world'

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
  return { geometry, first, second }
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
  private readonly waves
  private readonly crowns
  private readonly spray
  private readonly rainMaterial: ShaderMaterial
  private readonly sprayMaterial: ShaderMaterial
  private readonly crownMaterial: ShaderMaterial
  private readonly slopeMaterial: ShaderMaterial
  private readonly clearColor = new Color()
  private readonly resolution = new Vector2(1, 1)
  private readonly lampPositions: Vector3[]
  private readonly lampColors: Color[]
  private readonly moonColor = new Color()
  private readonly moonDirection = new Vector3()
  private readonly splashLimit: number
  private slopeDirty = true

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
    this.waves = instancedPlane(this.simulation.impacts.length, 'aImpact', 'aArrival')
    this.crowns = instancedPlane(this.splashLimit, 'aImpact', 'aArrival', 28)
    this.spray = instancedPlane(this.splashLimit * 5, 'aDrop', 'aVelocity')
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
    const uniforms = {
      ...surface,
      uResolution: { value: this.resolution },
      uPixelRatio: { value: 1 },
      uMoonColor: { value: this.moonColor },
      uMoonDirection: { value: this.moonDirection },
      uLampPosition: { value: this.lampPositions },
      uLampColor: { value: this.lampColors },
      uDepth: { value: null as Texture | null },
      uOverlay: { value: false },
      uOpacity: { value: 1 },
    }
    // Thin particle sheets use a single two-sided pass, rather than separate glass faces.
    this.rainMaterial = new ShaderMaterial({
      name: 'RainStreaks',
      vertexShader: RAIN_VERTEX,
      fragmentShader: RAIN_FRAGMENT,
      uniforms,
      defines: { LAMP_COUNT: this.lampPositions.length },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      forceSinglePass: true,
    })
    this.sprayMaterial = new ShaderMaterial({
      name: 'RainSpray',
      vertexShader: RAIN_VERTEX,
      fragmentShader: RAIN_FRAGMENT,
      uniforms,
      defines: { LAMP_COUNT: this.lampPositions.length, SURFACE_SPRAY: 1 },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      forceSinglePass: true,
    })
    this.crownMaterial = new ShaderMaterial({
      name: 'RainCrowns',
      vertexShader: CROWN_VERTEX,
      fragmentShader: CROWN_FRAGMENT,
      uniforms,
      defines: { LAMP_COUNT: this.lampPositions.length },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      forceSinglePass: true,
    })
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
    for (const [geometry, material] of [
      [this.drops.geometry, this.rainMaterial],
      [this.crowns.geometry, this.crownMaterial],
      [this.spray.geometry, this.sprayMaterial],
    ] as const) {
      const mesh = new Mesh(geometry, material)
      mesh.frustumCulled = false
      mesh.layers.set(RAIN_LAYER)
      this.group.add(mesh)
    }
    const waveMesh = new Mesh(this.waves.geometry, this.slopeMaterial)
    waveMesh.frustumCulled = false
    waveMesh.visible = slopesSupported
    if (!slopesSupported) this.slopeTarget.texture.type = UnsignedByteType
    this.slopes.add(waveMesh)
    this.slopeTarget.texture.name = 'Rain screen-space world slopes'
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

  resize(width: number, height: number, pixelRatio: number) {
    this.resolution.set(width, height)
    this.slopeTarget.setSize(width, height)
    this.rainMaterial.uniforms.uPixelRatio!.value = pixelRatio
    this.slopeDirty = true
  }

  update(delta: number, camera: PerspectiveCamera, opacity: number) {
    if (!this.group.visible) return
    this.simulation.update(delta)
    this.rainMaterial.uniforms.uOpacity!.value = opacity
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
      this.drops.second.setXYZW(count++, drop.vx, drop.vy, drop.vz, drop.seed)
    }
    this.upload(this.drops, count)
    let waveCount = 0
    let crownCount = 0
    let sprayCount = 0
    let splashCount = 0
    for (const impact of this.simulation.impacts) {
      const age = this.simulation.time - impact.born
      if (age < 0 || age >= IMPACT_LIFETIME) continue
      this.writeImpact(this.waves, waveCount++, impact, age)
      const distance = Math.hypot(impact.x - camera.position.x, impact.z - camera.position.z)
      if (age > 0.3 || impact.size < 0.0016 || distance > 42 || splashCount >= this.splashLimit)
        continue
      splashCount++
      if (age < 0.19) this.writeImpact(this.crowns, crownCount++, impact, age)
      for (let i = 0; i < 5; i++) {
        const angle = impact.seed * 31 + i * 2.399963
        const speed = 0.12 + impact.size * 55
        const vx = Math.cos(angle) * speed + impact.vx * 0.12
        const vz = Math.sin(angle) * speed + impact.vz * 0.12
        const vy = 0.55 + impact.size * 115 + Math.sin(i * 3 + impact.seed) * 0.15
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
  ) {
    batch.first.setXYZW(i, impact.x, impact.z, age, impact.size)
    batch.second.setXYZW(i, impact.vx, impact.vz, impact.seed, 0)
  }

  private upload(batch: ReturnType<typeof instancedPlane>, count: number) {
    batch.geometry.instanceCount = count
    for (const attribute of [batch.first, batch.second]) {
      attribute.clearUpdateRanges()
      if (count) attribute.addUpdateRange(0, count * 4)
      attribute.needsUpdate = true
    }
  }

  renderSlopes(renderer: WebGLRenderer, camera: PerspectiveCamera, lakeTime: number) {
    if (!this.slopeDirty) return
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
  }

  /** Composite after surface DOF, depth-testing against the opaque scene explicitly. */
  renderOverlay(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, depth: Texture) {
    if (!this.group.visible) return
    const layers = camera.layers.mask
    const background = scene.background
    const autoClear = renderer.autoClear
    this.rainMaterial.uniforms.uDepth!.value = depth
    this.rainMaterial.uniforms.uOverlay!.value = true
    this.rainMaterial.depthTest = false
    this.crownMaterial.depthTest = false
    this.sprayMaterial.depthTest = false
    try {
      camera.layers.set(RAIN_LAYER)
      scene.background = null
      renderer.autoClear = false
      renderer.render(scene, camera)
    } finally {
      camera.layers.mask = layers
      scene.background = background
      renderer.autoClear = autoClear
      this.rainMaterial.uniforms.uOverlay!.value = false
      this.rainMaterial.depthTest = true
      this.crownMaterial.depthTest = true
      this.sprayMaterial.depthTest = true
    }
  }

  dispose() {
    this.group.removeFromParent()
    for (const batch of [this.drops, this.waves, this.crowns, this.spray]) batch.geometry.dispose()
    this.rainMaterial.dispose()
    this.crownMaterial.dispose()
    this.sprayMaterial.dispose()
    this.slopeMaterial.dispose()
    this.slopeTarget.dispose()
  }
}
