import type { Camera, Scene } from 'three/webgpu'

import { BirdFlock, FLOCK } from './bird-flock'
import { BIRD_SPECIES, SPECIES } from './bird-species'
import type { BirdSpeciesName, FlockContext } from './bird-species'
import { FallingLeaves, LEAVES } from './falling-leaves'
import type { LeafHandOff, LeafWater } from './falling-leaves'
import { FlockSchedule } from './flock-schedule'
import type { LakeBed } from './lake-bed'
import type { LandscapeState } from './landscape-state'
import type { LightingState } from './lighting'
import { smoothstep } from './math'
import type { PhysicsWorld } from './physics-world'
import type { ScenePicker } from './scene-picking'
import type { Season, SeasonalLife } from './season'
import { SeasonalFauna } from './seasonal-fauna'
import type { SolarEndpoints } from './solar-clock'
import { DEFAULT_SOLAR, wrapDay } from './solar-clock'
import type { SceneWeatherState } from './weather-state'
import type { WindState } from './wind'

export type WildlifeWorld = Readonly<{
  scene: Scene
  camera: Camera
  bed: LakeBed
  picker: ScenePicker
  physics: Pick<PhysicsWorld, 'castDistance'>
  state: Readonly<LandscapeState>
  seed: number
  mobile: boolean
  lowPower: boolean
  season: Season
  life: SeasonalLife
  /** Where a leaf falling at (x, z) from `fromY` comes to rest: the ground, or the lake. */
  leafGround: (x: number, z: number, fromY: number) => { y: number; water: boolean }
  /** A leaf settling on the water rings it. */
  ripple: (x: number, z: number) => void
  /** The live lake surface floating leaves ride; the resting level without it. */
  leafWater?: LeafWater<WindState>
  /** Takes a leaf reaching open water into the physical floaters. */
  leafToWater?: LeafHandOff
}>

export type WildlifeFrame = Readonly<{
  dt: number
  solarSeconds: number
  solar: SolarEndpoints
  light: LightingState
  windSpeed: number
  rain: number
  weather: SceneWeatherState
}>

/**
 * The season's animals and leaves: flocks leaving the crowns by day, falling leaves, bats at
 * dusk and dawn, insects on warm days. Built in this order, as the scene always added them.
 */
export class LandscapeWildlife {
  readonly birds: BirdFlock
  readonly leaves: FallingLeaves<WindState>
  readonly fauna: SeasonalFauna
  readonly flocks: FlockSchedule
  private readonly world: WildlifeWorld
  /** Who flies depends on the hour and the sky; the latest frame's, for the flock schedule. */
  private readonly sky: { -readonly [K in keyof Omit<FlockContext, 'fromCrown'>]: FlockContext[K] }
  private readonly unpublish: () => void

  constructor(world: WildlifeWorld) {
    this.world = world
    const { scene, life, season } = world
    // Winter thins the flocks; low-power devices fly fewer birds.
    const share = life.birds * (world.lowPower ? FLOCK.lowPowerShare : 1)
    const flockSize = (species: BirdSpeciesName) =>
      Math.max(FLOCK.minimum, Math.round(SPECIES[species].count * share))
    this.birds = new BirdFlock(Math.max(...BIRD_SPECIES.map(flockSize)))
    scene.add(this.birds.group)
    const noon = (DEFAULT_SOLAR.sunset - DEFAULT_SOLAR.sunrise) / 2
    this.sky = { season, sinceSunrise: noon, untilSunset: noon, overcast: 0 }
    this.leaves = new FallingLeaves(
      world.mobile || world.lowPower ? LEAVES.mobileCapacity : LEAVES.capacity,
      world.camera.position,
      world.leafGround,
      world.ripple,
      Math.random,
      {
        lowPower: world.lowPower,
        ...(world.leafWater ? { water: world.leafWater } : {}),
        ...(world.leafToWater ? { handOff: world.leafToWater } : {}),
      },
    )
    scene.add(this.leaves.mesh)
    this.leaves.setSeason({
      rate: life.leafFall,
      trickle: life.leafTrickle,
      autumn: season.autumn,
      winter: season.winter,
    })
    this.fauna = new SeasonalFauna(
      scene,
      world.bed,
      world.seed,
      world.lowPower,
      life,
      world.state.reducedMotion,
    )
    this.flocks = new FlockSchedule({
      birds: this.birds,
      camera: world.camera,
      picker: world.picker,
      physics: world.physics,
      state: world.state,
      seed: world.seed,
      rate: life.birds,
      flockSize,
      context: () => this.sky,
    })
    // A capture hook, like the benchmark's: never called by the scene itself.
    const force = (species?: string, nearer?: number) => this.flocks.force(species, nearer)
    if (typeof window !== 'undefined') window.sceneFlock = force
    this.unpublish = () => {
      if (typeof window !== 'undefined' && window.sceneFlock === force) delete window.sceneFlock
    }
  }

  /** Hidden until a gust or a flight; every view compiles them up front. */
  get transient() {
    return [this.leaves.mesh, this.birds.group]
  }

  /** The forest's picking spheres: crowns to fly from and around, leaves to shed. */
  setForest(pick: Float32Array) {
    this.birds.setObstacles(pick)
    this.leaves.setSources(pick)
  }

  /** A frozen frame must not hold a flock or a leaf in mid-air. */
  setReducedMotion(value: boolean) {
    this.fauna.setReducedMotion(value)
    if (!value) return
    this.birds.cancel()
    this.leaves.clear()
    this.fauna.clear()
  }

  /** Bats at dusk and dawn, insects on warm days: the season's and the weather's wildlife. */
  updateFauna(frame: WildlifeFrame) {
    const { weather, light } = frame
    // The blended weather follows live refreshes; until a report carries a temperature the
    // season's typical one stands in.
    const { fog, snow, diffuse } = weather.levels
    const now = wrapDay(frame.solarSeconds)
    this.sky.sinceSunrise = now - frame.solar.sunrise
    this.sky.untilSunset = frame.solar.sunset - now
    this.sky.overcast = smoothstep(0.95, 0.65, diffuse)
    this.birds.setLight(light)
    this.birds.setHaze(this.world.scene.fog)
    this.fauna.update({
      time: this.world.state.elapsed,
      dt: frame.dt,
      solarSeconds: wrapDay(frame.solarSeconds),
      solar: frame.solar,
      daylight: light.daylight,
      sunDirection: light.sunDirection,
      sunColour: light.sunColor,
      viewer: this.world.camera.position,
      weather: {
        rain: frame.rain,
        windSpeed: frame.windSpeed,
        fog,
        snow,
        storm: weather.storm,
        temperature: weather.measuredTemperature ?? this.world.life.temperature,
      },
    })
    return this.fauna.summary
  }

  dispose() {
    this.unpublish()
    this.birds.group.removeFromParent()
    this.birds.dispose()
    this.fauna.dispose()
    this.leaves.dispose()
  }
}
