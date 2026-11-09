import { finiteUnit as unit, smoothstep } from './math'
import type { RainState } from './rain-simulation'
import { WEATHER } from './weather'
import type { WeatherPreset } from './weather'

/**
 * Every weather quantity the scene can change without compiling anything: the sky preset's
 * cloud and air settings, rain (with its wind), fog and snowfall. A live weather refresh moves
 * the scene from one set of levels to the next instead of switching presets.
 */
export type WeatherLevels = {
  coverage: number
  density: number
  bodyScale: number
  extinction: number
  diffuse: number
  rain: number
  rainWindX: number
  rainWindZ: number
  fog: number
  snow: number
}

export type WeatherInput = Readonly<{
  weather: WeatherPreset
  rain: RainState
  fog?: number
  snow?: number
}>

/** Seconds a refreshed weather takes to replace the one on screen. */
export const WEATHER_TRANSITION_SECONDS = 60

const finite = (value: number) => (Number.isFinite(value) ? value : 0)

export function weatherLevels(input: WeatherInput): WeatherLevels {
  const preset = WEATHER[input.weather]
  return {
    coverage: preset.coverage,
    density: preset.density,
    bodyScale: preset.bodyScale,
    extinction: preset.extinction,
    diffuse: preset.diffuse,
    rain: unit(input.rain.intensity),
    rainWindX: finite(input.rain.wind.x),
    rainWindZ: finite(input.rain.wind.z),
    fog: unit(input.fog),
    snow: unit(input.snow),
  }
}

/** A full cloud deck: no stars, shooting stars or wishes behind it (`coversSky` for levels). */
export function levelsCoverSky(levels: Readonly<WeatherLevels>) {
  return levels.diffuse < (WEATHER['partly-cloudy'].diffuse + WEATHER.cloudy.diffuse) / 2
}

const KEYS = [
  'coverage',
  'density',
  'bodyScale',
  'extinction',
  'diffuse',
  'rain',
  'rainWindX',
  'rainWindZ',
  'fog',
  'snow',
] as const satisfies readonly (keyof WeatherLevels)[]

/**
 * Eases the current levels toward a target over `duration` seconds of the caller's clock. A
 * new target mid-way starts from wherever the levels are, so there is never a jump.
 */
export class WeatherBlend {
  readonly current: WeatherLevels
  private from: WeatherLevels
  private to: WeatherLevels
  private start = 0
  private duration = 0
  private active = false

  constructor(initial: Readonly<WeatherLevels>) {
    this.current = { ...initial }
    this.from = { ...initial }
    this.to = { ...initial }
  }

  get target(): Readonly<WeatherLevels> {
    return this.to
  }

  get transitioning() {
    return this.active
  }

  /** A clock or duration that is not finite lands the target at once rather than blend in NaN. */
  retarget(target: Readonly<WeatherLevels>, time: number, duration = WEATHER_TRANSITION_SECONDS) {
    this.from = { ...this.current }
    this.to = { ...target }
    this.start = time
    this.duration = Number.isFinite(time) && Number.isFinite(duration) ? Math.max(0, duration) : 0
    this.active = true
    if (this.duration === 0) this.update(time)
  }

  /**
   * Advances to `time`; true when the levels changed (including the frame that lands). A
   * non-finite `time` mid-blend leaves the levels where they are.
   */
  update(time: number) {
    if (!this.active) return false
    const progress = this.duration > 0 ? (time - this.start) / this.duration : 1
    if (!Number.isFinite(progress)) return false
    // Smoothstep easing: a refresh starts and lands without a visible kink.
    const t = smoothstep(0, 1, progress)
    for (const key of KEYS)
      this.current[key] =
        t >= 1 ? this.to[key] : this.from[key] + (this.to[key] - this.from[key]) * t
    if (t >= 1) this.active = false
    return true
  }
}
