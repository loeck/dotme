import { finiteUnit as unit, smoothstep as smooth } from './math'
import { WeatherBlend, weatherLevels } from './weather-blend'
import type { WeatherInput, WeatherLevels } from './weather-blend'

export type SceneWeatherInput = WeatherInput &
  Readonly<{
    /** A thunderstorm is reported: lightning whatever the rain. */
    storm?: boolean
    /** Air temperature, °C: snow melts faster in warmer air. */
    temperature?: number
  }>

export type SceneWeatherOpening = SceneWeatherInput &
  Readonly<{
    /** The season's typical temperature, °C (`seasonalLife`), until a report carries one. */
    typicalTemperature?: number
  }>

const finite = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) ? value : undefined
// Every input to `smooth` below is already finite (`unit` maps non-finite reports to 0).

export const SNOW_COVER = {
  /** Seconds of full snowfall to whiten upward faces completely. */
  fill: 75,
  /** Seconds to melt a full cover at about 4 °C; colder air melts it more slowly. */
  melt: 110,
  /** The scene opens mid-snowfall: the ground already carries this share of its cover. */
  opening: 0.55,
} as const

/**
 * Snow lying on the upward faces of ground, stones and crowns, 0–1: it builds while snow falls
 * (at its intensity) and melts once it stops, faster in warmer air. Never above 1.
 */
export function advanceSnowCover(cover: number, snow: number, temperature: number, dt: number) {
  const step = Math.max(0, Number.isFinite(dt) ? dt : 0)
  const falling = unit(snow)
  if (falling > 0.001) return unit(cover + (falling * step) / SNOW_COVER.fill)
  const warmth = Number.isFinite(temperature)
    ? Math.max(0.25, Math.min(3, (temperature + 2) / 6))
    : 1
  return unit(cover - (warmth * step) / SNOW_COVER.melt)
}

/** Seconds the air stays full of drops after the rain eases: the rainbow's window. */
export const RAIN_MEMORY_SECONDS = 150

/** Follows rain up at once and lets it decay slowly, so a passing shower leaves wet air behind. */
export function advanceRainMemory(memory: number, rain: number, dt: number) {
  const step = Math.max(0, Number.isFinite(dt) ? dt : 0)
  return Math.max(unit(rain), unit(memory) * Math.exp(-step / RAIN_MEMORY_SECONDS))
}

/**
 * Strength of the rainbow, 0–1, before the sky checks that the sun itself is clear of cloud: the
 * sun must be up but under 42° (higher, the whole bow sinks below the horizon), with drops in the
 * air: light to moderate rain now, or a shower that has just passed. A downpour or a storm hides
 * the sun, and snow or fog scatter no bow.
 */
export function rainbowFactor(
  input: Readonly<{
    /** Sine of the sun's elevation. */
    sunHeight: number
    rain: number
    /** `advanceRainMemory`: the rain the air still holds. */
    rainMemory: number
    fog?: number
    snow?: number
    storm?: boolean
  }>,
) {
  const height = Number.isFinite(input.sunHeight) ? input.sunHeight : -1
  // Up a few degrees, and gone well before 42°, where the bow's top meets the horizon.
  const elevation = smooth(0.015, 0.07, height) * (1 - smooth(0.5, 0.64, height))
  const rain = unit(input.rain)
  const falling = smooth(0.03, 0.2, rain) * (1 - smooth(0.62, 0.95, rain))
  const passed = smooth(0.05, 0.3, unit(input.rainMemory)) * (1 - smooth(0.62, 0.95, rain))
  const wet = Math.max(falling, passed)
  const clearAir =
    (1 - smooth(0.1, 0.5, unit(input.fog ?? 0))) * (1 - smooth(0.05, 0.3, unit(input.snow ?? 0)))
  return elevation * wet * clearAir * (input.storm ? 0.35 : 1)
}

/**
 * The scene's weather over time: the blended levels a live refresh eases between, the snow
 * lying on the ground and the rain the air remembers. Pure state; the engine applies it.
 */
export class SceneWeatherState {
  readonly blend: WeatherBlend
  snowCover: number
  rainMemory: number
  storm: boolean
  /** Air temperature, °C, for the snow's melt: the last reported one, else the season's typical. */
  temperature: number
  /** The last reported air temperature, °C; undefined until a report carries one. */
  measuredTemperature: number | undefined

  constructor(input: SceneWeatherOpening) {
    const levels = weatherLevels(input)
    this.blend = new WeatherBlend(levels)
    this.snowCover = levels.snow > 0 ? SNOW_COVER.opening * Math.sqrt(levels.snow) : 0
    this.rainMemory = levels.rain
    this.storm = input.storm ?? false
    this.measuredTemperature = finite(input.temperature)
    this.temperature = this.measuredTemperature ?? finite(input.typicalTemperature) ?? 10
  }

  get levels(): Readonly<WeatherLevels> {
    return this.blend.current
  }

  /**
   * A refreshed weather: ease toward it over `duration` seconds. 0 (reduced motion) applies it at
   * once, with the snow cover and the wet air already at rest.
   */
  set(input: SceneWeatherInput, time: number, duration?: number) {
    this.storm = input.storm ?? false
    const temperature = finite(input.temperature)
    if (temperature !== undefined) this.temperature = this.measuredTemperature = temperature
    this.blend.retarget(weatherLevels(input), time, duration)
    if (duration === 0) this.rest()
  }

  /** Lands an easing refresh at once (reduced motion turned on mid-blend). */
  settle(time: number) {
    this.blend.retarget(this.blend.target, time, 0)
    this.rest()
  }

  /**
   * Snaps the snow cover and rain memory to where the current levels would leave them at rest:
   * a frozen scene (reduced motion) never advances them, yet must still follow the weather.
   */
  private rest() {
    const { snow, rain } = this.blend.current
    // Any snowfall eventually whitens the faces completely, and any thaw clears them.
    this.snowCover = snow > 0.001 ? 1 : 0
    this.rainMemory = rain
  }

  /**
   * Advances the blend to `time` (seconds) and the cover and memory by `dt`; a frozen scene
   * (reduced motion) keeps its cover. True when the blended levels changed this frame.
   */
  advance(time: number, dt: number, frozen = false) {
    const changed = this.blend.update(time)
    const levels = this.blend.current
    if (!frozen) {
      this.snowCover = advanceSnowCover(this.snowCover, levels.snow, this.temperature, dt)
      this.rainMemory = advanceRainMemory(this.rainMemory, levels.rain, dt)
    }
    return changed
  }

  rainbow(sunHeight: number) {
    const levels = this.blend.current
    return rainbowFactor({
      sunHeight,
      rain: levels.rain,
      rainMemory: this.rainMemory,
      fog: levels.fog,
      snow: levels.snow,
      storm: this.storm,
    })
  }
}
