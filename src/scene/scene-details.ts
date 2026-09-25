import { Mesh, MeshStandardNodeMaterial } from 'three/webgpu'
import type { Camera, Object3D, Scene, Vector3, WebGPURenderer } from 'three/webgpu'

import type { FishBait } from './fish-pointer'
import { FloatingBodies } from './floating-bodies'
import { FoamDrift } from './foam-drift'
import { LakeCaustics } from './lake-caustics'
import { LakeFireflies } from './lake-fireflies'
import type { FireflyPointer } from './lake-fireflies'
import { LakeFish } from './lake-fish'
import { LakeRay } from './lake-ray'
import { LakeSand } from './lake-sand'
import { LakeSplashes } from './lake-splashes'
import type { LakeWaterMaterial } from './lake-water'
import { LakeWaterfall } from './lake-waterfall'
import type { PhysicsWorld } from './physics-world'
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
  private readonly ray: LakeRay

  get rayWake(): LakeRay['wake'] {
    return this.ray.wake
  }
  private readonly splashes: LakeSplashes
  private readonly floating: FloatingBodies
  private readonly foam: FoamDrift
  private readonly fireflies: LakeFireflies
  private readonly waterfall: LakeWaterfall | undefined
  private readonly wetness = this.resources.own(new ShoreWetness())
  private readonly sand: LakeSand
  private environment: DetailEnvironment = { rainIntensity: 0, daylight: 0 }

  private readonly reducedMotion: boolean

  constructor(
    scene: Scene,
    world: Pick<VoxelWorld, 'seed' | 'lakeBed' | 'waterfall'>,
    mobile: boolean,
    reducedMotion: boolean,
    physics: PhysicsWorld,
    environment: Partial<DetailEnvironment> = {},
  ) {
    this.reducedMotion = reducedMotion
    this.environment = updateDetailEnvironment(this.environment, environment)
    if (reducedMotion) this.wetness.setWetness(this.environment.rainIntensity)
    this.caustics = this.resources.own(new LakeCaustics(reducedMotion))
    this.sand = this.resources.own(new LakeSand(world.seed))
    this.fish = this.resources.own(
      new LakeFish(scene, world.lakeBed, world.seed, mobile, physics, reducedMotion),
    )
    this.ray = this.resources.own(new LakeRay(scene, world.lakeBed, world.seed, reducedMotion))
    this.fireflies = this.resources.own(new LakeFireflies(scene, world.lakeBed, world.seed, mobile))
    this.splashes = this.resources.own(
      new LakeSplashes(scene, world.lakeBed, world.seed, mobile, physics),
    )
    this.floating = this.resources.own(
      new FloatingBodies(scene, world.lakeBed, world.seed, mobile, physics, this.splashes),
    )
    this.foam = this.resources.own(new FoamDrift(scene, world.lakeBed, world.seed, mobile))
    if (world.waterfall) {
      this.waterfall = this.resources.own(
        new LakeWaterfall(
          scene,
          world.waterfall,
          mobile,
          reducedMotion,
          (jet) => this.splashes.emit(jet),
          physics,
        ),
      )
    }
  }

  /** Called after global cloud hooks so every material retains all its effects. */
  attachMaterials(
    terrain: Object3D,
    submerged: readonly MeshStandardNodeMaterial[],
    sand: MeshStandardNodeMaterial,
  ) {
    const materials = new Set<MeshStandardNodeMaterial>()
    terrain.traverse((object) => {
      if (object instanceof Mesh && object.material instanceof MeshStandardNodeMaterial)
        materials.add(object.material)
    })
    for (const material of materials) this.wetness.applyTo(material)
    for (const material of submerged) this.caustics.applyTo(material)
    this.sand.applyTo(sand)
  }

  get impactSlopes() {
    return this.splashes.impacts.slopes
  }

  setWaterImpact(handler: LakeSplashes['onReturn'], uniforms: LakeWaterMaterial['uniforms']) {
    this.splashes.impacts.setWaterSurface(uniforms)
    this.waterfall?.setWaterSurface(uniforms)
    if (handler) this.splashes.onReturn = handler
    else delete this.splashes.onReturn
    if (handler) this.floating.onWake = handler
    else delete this.floating.onWake
  }

  pointerBurst(x: number, z: number, energy: number, time: number, wind: WindState) {
    if (this.disposed || this.reducedMotion) return
    this.splashes.spawnBurst(x, z, energy, time, wind)
  }

  setWaterfallBlock(across: number, height: number, radius: number, strength: number) {
    this.waterfall?.setBlock(across, height, radius, strength)
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
    bait: FishBait | null = null,
  ) {
    if (this.disposed) return
    const { daylight, rainIntensity } = this.environment
    this.caustics.update(
      time,
      wind,
      (0.65 * moonIntensity * (1 - daylight) + daylight) * intro,
      waterPointer,
      pointerLightStrength,
    )
    this.fish.update(time, dt, waterPointer, scenePointer, bait)
    this.ray.update(time, dt)
    this.waterfall?.update(time, daylight, intro, wind)
    this.floating.update(time, wind, this.reducedMotion)
    this.foam.update(time, wind, this.reducedMotion)
    this.splashes.update(time, wind, this.reducedMotion, intro)
    // The curtain uploads after the shared step; frozen when reduced motion holds it.
    if (!this.reducedMotion) this.waterfall?.syncCurtain()
    this.wetness.update(this.reducedMotion ? 0 : dt, rainIntensity)
    this.fireflies.update(time, wind, {
      reducedMotion: this.reducedMotion,
      nightFactor: 1 - daylight,
      intensity: intro * (1 - rainIntensity * 0.8),
      pointer: scenePointer,
    })
  }

  private withFirefliesVisible<T>(action: () => T): T {
    const visible = this.fireflies.mesh.visible
    try {
      this.fireflies.mesh.visible = this.fireflies.mesh.geometry.instanceCount > 0
      return action()
    } finally {
      this.fireflies.mesh.visible = visible
    }
  }

  /** Include intermittent effects in the existing scene/camera/target compilation pass. */
  compileAsync(compile: () => Promise<void>): Promise<void> {
    const compileMaterials = () => (this.waterfall ? this.waterfall.compile(compile) : compile())
    if (this.reducedMotion) return compileMaterials()
    return this.withFirefliesVisible(() => this.splashes.compileAsync(compileMaterials))
  }

  async prepareFluid(renderer: WebGPURenderer, camera: Camera) {
    await this.waterfall?.prepareFluid(renderer, camera)
  }

  /** Warm the renderer's nested reflection pass after its asynchronous graph compilation. */
  warmup(render: () => void) {
    if (this.reducedMotion) return render()
    this.withFirefliesVisible(() => this.splashes.warmup(render))
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.resources.dispose()
  }
}
