import { Color, Mesh, MeshStandardMaterial } from 'three'
import type { Object3D, Scene, Vector3 } from 'three'

import { LakeCaustics } from './lake-caustics'
import { LakeFireflies } from './lake-fireflies'
import type { FireflyPointer } from './lake-fireflies'
import { LakeFish } from './lake-fish'
import { LakeMist } from './lake-mist'
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
  private readonly caustics: LakeCaustics
  private readonly fish: LakeFish
  private readonly mist: LakeMist
  private readonly fireflies: LakeFireflies
  private readonly wetness = new ShoreWetness()
  private readonly lightColor = new Color()
  private readonly nightColor = new Color(0x9db8ce)
  private readonly dayColor = new Color(0xffe4bb)
  private environment: DetailEnvironment = { rainIntensity: 0, daylight: 0 }

  constructor(
    scene: Scene,
    world: VoxelWorld,
    mobile: boolean,
    private readonly reducedMotion: boolean,
    environment: Partial<DetailEnvironment> = {},
  ) {
    this.environment = updateDetailEnvironment(this.environment, environment)
    if (reducedMotion) this.wetness.setWetness(this.environment.rainIntensity)
    this.caustics = new LakeCaustics(reducedMotion)
    this.fish = new LakeFish(scene, world.lakeBed, world.seed, mobile, reducedMotion)
    this.mist = new LakeMist(scene, world.lakeBed, world.seed, mobile)
    this.fireflies = new LakeFireflies(scene, world.lakeBed, world.seed, mobile)
  }

  /** Called after global cloud and cursor hooks so every material retains all its effects. */
  attachMaterials(terrain: Object3D, submerged: readonly MeshStandardMaterial[]) {
    const materials = new Set<MeshStandardMaterial>()
    terrain.traverse((object) => {
      if (object instanceof Mesh && object.material instanceof MeshStandardMaterial)
        materials.add(object.material)
    })
    for (const material of materials) this.wetness.applyTo(material)
    for (const material of submerged) this.caustics.applyTo(material)
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
  ) {
    const { daylight, rainIntensity } = this.environment
    this.lightColor.copy(this.nightColor).lerp(this.dayColor, daylight)
    this.caustics.update(
      time,
      wind,
      (0.24 * moonIntensity * (1 - daylight) + daylight) * intro,
      waterPointer,
    )
    this.fish.update(time, dt, waterPointer, scenePointer)
    this.wetness.update(this.reducedMotion ? 0 : dt, rainIntensity)
    this.mist.update(time, wind, {
      reducedMotion: this.reducedMotion,
      daylight,
      lightColor: this.lightColor,
      intensity: intro * (1 - rainIntensity * 0.35),
    })
    this.fireflies.update(time, wind, {
      reducedMotion: this.reducedMotion,
      nightFactor: 1 - daylight,
      intensity: intro * (1 - rainIntensity * 0.8),
      pointer: scenePointer,
    })
  }

  dispose() {
    this.caustics.dispose()
    this.fish.dispose()
    this.mist.dispose()
    this.fireflies.dispose()
    this.wetness.dispose()
  }
}
