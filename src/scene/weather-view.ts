import { Color, Vector2 } from 'three/webgpu'
import type { FogExp2 } from 'three/webgpu'

import type { LandscapeState } from './landscape-state'
import type { LightingState } from './lighting'
import type { RainEffect } from './rain-effect'
import type { createSkyMaterial } from './sky-material'
import { updateSkyWeather } from './sky-material'
import { snowCover } from './snow-cover'
import type { VolumetricClouds } from './volumetric-clouds'
import type { VolumetricLight } from './volumetric-light'
import type { SceneWeatherState } from './weather-state'
import type { WindModel } from './wind'

export type WeatherScene = Readonly<{
  weather: SceneWeatherState
  clouds: VolumetricClouds
  rain: RainEffect
  atmosphere: VolumetricLight
  fog: FogExp2
  skyMaterial: ReturnType<typeof createSkyMaterial>
  wind: WindModel
  state: Readonly<LandscapeState>
  /** Rain and dry air give the mirror different budgets. */
  onRainingChange: () => void
}>

/**
 * Draws the blended weather (`weather-state.ts`): the clouds, rain and snow follow its levels,
 * the snow cover its ground, and the air, sky and material fog its fog banks and rainbow.
 */
export class WeatherView {
  private readonly world: WeatherScene
  /** Where the fog banks' noise has drifted with the wind. */
  private readonly fogDrift = new Vector2()
  private readonly fogColor = new Color()

  constructor(world: WeatherScene) {
    this.world = world
  }

  /** Advance the weather blend, snow cover and rain memory; push changed levels to the scene. */
  update(now: number, dt: number) {
    const state = this.world.weather
    if (state.advance(now / 1000, dt, this.world.state.reducedMotion)) this.applyLevels()
    snowCover.value = state.snowCover
  }

  applyLevels() {
    const { clouds, rain } = this.world
    const levels = this.world.weather.levels
    clouds.setWeather(levels)
    const current = rain.simulation.state
    const wasRaining = rain.raining
    if (
      Math.abs(current.intensity - levels.rain) > 1e-4 ||
      current.wind.x !== levels.rainWindX ||
      current.wind.z !== levels.rainWindZ
    )
      rain.setRainState({
        intensity: levels.rain < 0.002 ? 0 : levels.rain,
        wind: { x: levels.rainWindX, z: levels.rainWindZ },
      })
    if (Math.abs(rain.snow.intensity - levels.snow) > 1e-4)
      rain.setSnow(levels.snow < 0.002 ? 0 : levels.snow)
    if (wasRaining !== rain.raining) this.world.onRainingChange()
  }

  /** Ground fog in the air, the sky, the materials' fog (the mirror and rain) and the rainbow. */
  applyFog(light: LightingState) {
    const { state, weather } = this.world
    const levels = weather.levels
    const fog = levels.fog
    if (!state.reducedMotion) {
      const wind = this.world.wind.sample(state.elapsed).displacement
      // The banks creep with a fifth of the wind and slowly change shape on their own.
      this.fogDrift.set(-wind[0] * 0.2 * 0.032 + state.elapsed * 0.004, -wind[1] * 0.2 * 0.032)
    }
    // Fog takes the sky's horizon light, greyed: a pale veil by day, a dim one at night.
    const haze = light.haze
    const grey = haze.r * 0.2126 + haze.g * 0.7152 + haze.b * 0.0722
    this.fogColor
      .setRGB(grey, grey, grey)
      .lerp(haze, 0.45)
      .multiplyScalar(0.62 + 0.38 * light.weatherDiffuse)
    this.world.atmosphere.setWeather(levels.extinction, fog, this.fogColor, this.fogDrift)
    this.world.fog.density += fog * fog * 0.022
    updateSkyWeather(this.world.skyMaterial, fog, weather.rainbow(light.sunDirection.y))
  }
}
