import { Mesh, MeshStandardNodeMaterial } from 'three/webgpu'
import type { Camera, Object3D, Scene, Vector3, WebGPURenderer } from 'three/webgpu'

import { LakeCaustics } from './lake-caustics'
import { LakeFireflies } from './lake-fireflies'
import type { FireflyPointer } from './lake-fireflies'
import { LakeFish } from './lake-fish'
import { LakeSplashes } from './lake-splashes'
import type { LakeWaterMaterial } from './lake-water'
import { LakeWaterfall } from './lake-waterfall'
import { ResourceScope } from './resource-scope'
import { ShoreWetness } from './shore-wetness'
import type { VoxelWorld } from './voxel-world'
import type { WindState } from './wind'

/** Normalized inputs supplied by the rain/solar integrations, without fetching weather here. */
export type DetailEnvironment = Readonly<{
  rainIntensity: number
  daylight: number
}>

const bounded = (value: number | undefined, fallback: number) =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.min(1, value))

export function updateDetailEnvironment(
  current: DetailEnvironment,
  update: Partial<DetailEnvironment>,
): DetailEnvironment {
  return {
    rainIntensity: bounded(update.rainIntensity, current.rainIntensity),
    daylight: bounded(update.daylight, current.daylight),
  }
}

/** Owns the optional detail layer; the engine retains the clock, wind, picking and light passes. */
export class SceneDetails {
  private readonly resources = new ResourceScope()
  private disposed = false
  private readonly caustics: LakeCaustics
  private readonly fish: LakeFish
  private readonly splashes: LakeSplashes
  private readonly fireflies: LakeFireflies
  private readonly waterfall: LakeWaterfall | undefined
  private waterImpact: LakeSplashes['onReturn']
  private effectTime = 0
  private readonly wetness = this.resources.own(new ShoreWetness())
  private environment: DetailEnvironment = { rainIntensity: 0, daylight: 0 }

  private readonly reducedMotion: boolean

  constructor(
    scene: Scene,
    world: Pick<VoxelWorld, 'seed' | 'lakeBed' | 'waterfall'>,
    mobile: boolean,
    reducedMotion: boolean,
    environment: Partial<DetailEnvironment> = {},
  ) {
    this.reducedMotion = reducedMotion
    this.environment = updateDetailEnvironment(this.environment, environment)
    if (reducedMotion) this.wetness.setWetness(this.environment.rainIntensity)
    try {
      this.caustics = this.resources.own(new LakeCaustics(reducedMotion))
      this.fish = this.resources.own(
        new LakeFish(scene, world.lakeBed, world.seed, mobile, reducedMotion),
      )
      this.fireflies = this.resources.own(
        new LakeFireflies(scene, world.lakeBed, world.seed, mobile),
      )
      this.splashes = this.resources.own(new LakeSplashes(scene, world.lakeBed, world.seed, mobile))
      if (world.waterfall) {
        this.waterfall = this.resources.own(
          new LakeWaterfall(scene, world.waterfall, mobile, reducedMotion),
        )
        this.waterfall.onImpact = (x, z, radius, velocity, energy) => {
          this.splashes.impacts.add(x, z, this.effectTime, energy)
          this.waterImpact?.(x, z, radius, velocity)
        }
      }
    } catch (error) {
      this.resources.dispose()
      throw error
    }
  }

  /** Called after global cloud hooks so every material retains all its effects. */
  attachMaterials(terrain: Object3D, submerged: readonly MeshStandardNodeMaterial[]) {
    const materials = new Set<MeshStandardNodeMaterial>()
    terrain.traverse((object) => {
      if (object instanceof Mesh && object.material instanceof MeshStandardNodeMaterial)
        materials.add(object.material)
    })
    for (const material of materials) this.wetness.applyTo(material)
    for (const material of submerged) this.caustics.applyTo(material)
  }

  get impactSlopes() {
    return this.splashes.impacts.slopes
  }

  setWaterImpact(handler: LakeSplashes['onReturn'], uniforms: LakeWaterMaterial['uniforms']) {
    this.waterImpact = handler
    this.splashes.impacts.setWaterSurface(uniforms)
    this.waterfall?.setWaterSurface(uniforms)
    if (handler) this.splashes.onReturn = handler
    else delete this.splashes.onReturn
  }

  setEnvironment(environment: Partial<DetailEnvironment>) {
    this.environment = updateDetailEnvironment(this.environment, environment)
    // A weather-state change is immediate with reduced motion; only its transition is frozen.
    if (this.reducedMotion) this.wetness.setWetness(this.environment.rainIntensity)
  }

  update(
    time: number,
    dt: number,
    wind: WindState,
    waterPointer: Vector3 | null,
    scenePointer: FireflyPointer | null,
    moonIntensity: number,
    intro: number,
    pointerLightStrength = 1,
  ) {
    if (this.disposed) return
    const { daylight, rainIntensity } = this.environment
    this.effectTime = time
    this.caustics.update(
      time,
      wind,
      (0.24 * moonIntensity * (1 - daylight) + daylight) * intro,
      waterPointer,
      pointerLightStrength,
    )
    this.fish.update(time, dt, waterPointer, scenePointer)
    this.waterfall?.update(time, daylight, intro)
    this.splashes.update(time, wind, this.reducedMotion, intro)
    this.wetness.update(this.reducedMotion ? 0 : dt, rainIntensity)
    this.fireflies.update(time, wind, {
      reducedMotion: this.reducedMotion,
      nightFactor: 1 - daylight,
      intensity: intro * (1 - rainIntensity * 0.8),
      pointer: scenePointer,
    })
  }

  /** Include intermittent effects in the existing scene/camera/target compilation pass. */
  compileAsync(compile: () => Promise<void>): Promise<void> {
    const compileMaterials = () => (this.waterfall ? this.waterfall.compile(compile) : compile())
    if (this.reducedMotion) return compileMaterials()
    const visible = this.fireflies.mesh.visible
    try {
      this.fireflies.mesh.visible = this.fireflies.mesh.geometry.instanceCount > 0
      return this.splashes.compileAsync(compileMaterials)
    } finally {
      this.fireflies.mesh.visible = visible
    }
  }

  async prepareFluid(renderer: WebGPURenderer, camera: Camera) {
    await this.waterfall?.prepareFluid(renderer, camera)
  }

  /** Warm the renderer's nested reflection pass after its asynchronous graph compilation. */
  warmup(render: () => void) {
    if (this.reducedMotion) {
      render()
      return
    }
    const visible = this.fireflies.mesh.visible
    try {
      this.fireflies.mesh.visible = this.fireflies.mesh.geometry.instanceCount > 0
      this.splashes.warmup(render)
    } finally {
      this.fireflies.mesh.visible = visible
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.waterImpact = undefined
    this.resources.dispose()
  }
}
