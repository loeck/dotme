import type { Color, Object3D, Scene, Vector3 } from 'three/webgpu'

import type { LakeBed } from './lake-bed'
import { LakeInsects } from './lake-insects'
import { smoothstep as smooth } from './math'
import type { SeasonalLife } from './season'
import { UNDERGROWTH_LAYER } from './vegetation'

/** Weather the engine does not simulate but the wildlife answers; every field optional. */
export type FaunaClimate = Readonly<{
  /** Air temperature, °C; the season's typical value stands in when it is unknown. */
  temperature?: number
  /** 0–1 fog density. */
  fog?: number
  /** 0–1 snowfall. */
  snow?: number
}>

export type FaunaWeather = Readonly<{
  rain: number
  windSpeed: number
  fog: number
  snow: number
  storm: boolean
  temperature: number
}>

/**
 * How much of the season's wildlife is out, 0–1: dragonflies and midges need a warm, dry, calm
 * day. `daylight` is the scene's 0–1 daylight.
 */
export function faunaConditions(
  life: Pick<SeasonalLife, 'insects'>,
  weather: FaunaWeather,
  daylight: number,
) {
  const dry =
    (1 - smooth(0.02, 0.12, weather.rain)) *
    (1 - smooth(0.15, 0.45, weather.fog)) *
    (1 - smooth(0.02, 0.15, weather.snow)) *
    (weather.storm ? 0 : 1)
  const calm = 1 - smooth(3.5, 6.5, weather.windSpeed)
  return {
    insects:
      life.insects * dry * calm * smooth(13, 20, weather.temperature) * smooth(0.3, 0.6, daylight),
  }
}

export type FaunaFrame = Readonly<{
  time: number
  dt: number
  daylight: number
  sunDirection: Vector3
  sunColour: Color
  /** The camera's position, which the dragonflies tip toward. */
  viewer: Vector3
  weather: FaunaWeather
}>

/**
 * The season's small wildlife: dragonflies and midge swarms over the shallows on warm days. Main view only (the mirror, probe and shadows never
 * draw a few pixels of insect); reduced motion shows none, as with the birds.
 */
export class SeasonalFauna {
  private readonly insects: LakeInsects
  private readonly life: SeasonalLife
  private reducedMotion: boolean
  /** Latest 0–1 conditions, for diagnostics. */
  conditions = { insects: 0 }

  constructor(
    scene: Scene,
    bed: LakeBed,
    seed: number,
    lowPower: boolean,
    life: SeasonalLife,
    reducedMotion: boolean,
  ) {
    this.life = life
    this.reducedMotion = reducedMotion
    this.insects = new LakeInsects(bed, seed, lowPower)
    for (const mesh of this.meshes) {
      mesh.layers.set(UNDERGROWTH_LAYER)
      scene.add(mesh)
    }
  }

  private get meshes(): Object3D[] {
    return [this.insects.midges, this.insects.dragonflies]
  }

  /** Runs a compile with every draw shown, so their programs exist before the first frame. */
  compileVisible<T>(action: () => T): T {
    const states = this.meshes.map((mesh) => [mesh, mesh.visible] as const)
    try {
      for (const [mesh] of states) mesh.visible = true
      return action()
    } finally {
      for (const [mesh, visible] of states) mesh.visible = visible
    }
  }

  /**
   * Conditions in tenths and what was placed, for the host's `data-wildlife` diagnostics. Read
   * each frame: the string is rebuilt only when one of its parts changes.
   */
  get summary() {
    const insectTenths = Math.round(this.conditions.insects * 10),
      { swarms, flyCount } = this.insects
    const key = this.summaryKey
    if (key[0] !== insectTenths || key[1] !== swarms || key[2] !== flyCount) {
      key[0] = insectTenths
      key[1] = swarms
      key[2] = flyCount
      this.summaryText = `insects:${(insectTenths / 10).toFixed(1)} swarms:${swarms} dragonflies:${flyCount}`
    }
    return this.summaryText
  }
  private readonly summaryKey = [Number.NaN, Number.NaN, Number.NaN]
  private summaryText = ''

  setReducedMotion(value: boolean) {
    this.reducedMotion = value
    if (value) this.clear()
  }

  update(frame: FaunaFrame) {
    if (this.reducedMotion) return
    this.conditions = faunaConditions(this.life, frame.weather, frame.daylight)
    this.insects.update(
      frame.time,
      frame.dt,
      this.conditions.insects,
      frame.sunDirection,
      frame.sunColour,
      frame.viewer,
    )
  }

  clear() {
    this.insects.clear()
  }

  dispose() {
    this.insects.dispose()
  }
}
