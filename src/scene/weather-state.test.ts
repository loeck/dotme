import { Vector3 } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { sampleLighting } from './lighting'
import { stagedRainbowCentre } from './rainbow'
import { SnowSimulation } from './snow-simulation'
import { DEFAULT_SOLAR } from './solar-clock'
import { WEATHER } from './weather'
import {
  levelsCoverSky,
  WEATHER_TRANSITION_SECONDS,
  WeatherBlend,
  weatherLevels,
} from './weather-blend'
import {
  advanceRainMemory,
  advanceSnowCover,
  rainbowFactor,
  RAIN_MEMORY_SECONDS,
  SceneWeatherState,
  SNOW_COVER,
} from './weather-state'

const dry = { intensity: 0, wind: { x: 1, z: 0 } }
const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length

describe('weather blending', () => {
  it('maps presets and conditions to bounded levels', () => {
    const levels = weatherLevels({
      weather: 'fog',
      rain: { intensity: 2, wind: { x: 3, z: -1 } },
      fog: 0.85,
      snow: -1,
    })
    expect(levels).toMatchObject({
      ...WEATHER.fog,
      rain: 1,
      rainWindX: 3,
      rainWindZ: -1,
      fog: 0.85,
      snow: 0,
    })
    expect(levelsCoverSky(weatherLevels({ weather: 'clear', rain: dry }))).toBe(false)
    expect(levelsCoverSky(weatherLevels({ weather: 'partly-cloudy', rain: dry }))).toBe(false)
    for (const preset of ['cloudy', 'overcast', 'fog', 'snow'] as const)
      expect(levelsCoverSky(weatherLevels({ weather: preset, rain: dry }))).toBe(true)
  })

  it('eases from the current levels to a refresh over a minute, without jumps', () => {
    const blend = new WeatherBlend(weatherLevels({ weather: 'clear', rain: dry }))
    const target = weatherLevels({ weather: 'overcast', rain: { intensity: 0.6, wind: dry.wind } })
    blend.retarget(target, 100)
    expect(blend.transitioning).toBe(true)
    blend.update(100)
    expect(blend.current.rain).toBe(0)
    let previous = 0
    for (let t = 0; t <= WEATHER_TRANSITION_SECONDS; t += 5) {
      blend.update(100 + t)
      expect(blend.current.rain).toBeGreaterThanOrEqual(previous)
      expect(blend.current.rain - previous).toBeLessThan(0.1)
      previous = blend.current.rain
    }
    expect(blend.current).toMatchObject(target)
    expect(blend.transitioning).toBe(false)
    expect(blend.update(1000)).toBe(false)
  })

  it('restarts from wherever it is when a new target arrives mid-way', () => {
    const blend = new WeatherBlend(weatherLevels({ weather: 'clear', rain: dry }))
    blend.retarget(weatherLevels({ weather: 'overcast', rain: dry }), 0)
    blend.update(30)
    const halfway = blend.current.coverage
    expect(halfway).toBeGreaterThan(0)
    expect(halfway).toBeLessThan(WEATHER.overcast.coverage)
    blend.retarget(weatherLevels({ weather: 'clear', rain: dry }), 30)
    blend.update(30)
    expect(blend.current.coverage).toBeCloseTo(halfway)
    blend.retarget(weatherLevels({ weather: 'fog', rain: dry, fog: 1 }), 31, 0)
    expect(blend.current.fog).toBe(1)
    expect(blend.transitioning).toBe(false)
  })

  it('never blends in NaN from a broken clock', () => {
    const clear = weatherLevels({ weather: 'clear', rain: dry })
    const overcast = weatherLevels({ weather: 'overcast', rain: dry })
    const blend = new WeatherBlend(clear)
    blend.retarget(overcast, 0)
    blend.update(15)
    const partway = blend.current.coverage
    // A non-finite frame time mid-blend holds the levels, and a later finite one resumes.
    expect(blend.update(Number.NaN)).toBe(false)
    expect(blend.current.coverage).toBe(partway)
    blend.update(WEATHER_TRANSITION_SECONDS)
    expect(blend.current).toMatchObject(overcast)
    // A non-finite start or duration lands the target at once.
    blend.retarget(clear, Number.NaN)
    expect(blend.current).toMatchObject(clear)
    expect(blend.transitioning).toBe(false)
    blend.retarget(overcast, 0, Number.NaN)
    expect(blend.current).toMatchObject(overcast)
    for (const value of Object.values(blend.current)) expect(Number.isFinite(value)).toBe(true)
  })
})

describe('snow cover and rain memory', () => {
  it('builds with snowfall up to a full cover and melts once it stops', () => {
    let cover = 0
    for (let i = 0; i < 30; i++) cover = advanceSnowCover(cover, 1, -2, 1)
    expect(cover).toBeCloseTo(30 / SNOW_COVER.fill)
    for (let i = 0; i < 300; i++) cover = advanceSnowCover(cover, 0.5, -2, 1)
    expect(cover).toBe(1)
    const cold = advanceSnowCover(1, 0, -5, 30),
      warm = advanceSnowCover(1, 0, 10, 30)
    expect(cold).toBeLessThan(1)
    expect(warm).toBeLessThan(cold)
    expect(advanceSnowCover(0.1, 0, 20, 1e4)).toBe(0)
    expect(advanceSnowCover(0.4, Number.NaN, Number.NaN, Number.NaN)).toBe(0.4)
  })

  it('remembers a passing shower and forgets it over a few minutes', () => {
    expect(advanceRainMemory(0, 0.6, 1)).toBe(0.6)
    const later = advanceRainMemory(0.6, 0, RAIN_MEMORY_SECONDS)
    expect(later).toBeCloseTo(0.6 / Math.E)
    expect(advanceRainMemory(later, 0.8, 1)).toBe(0.8)
  })

  it('opens a snowy scene already dusted and freezes the cover under reduced motion', () => {
    const state = new SceneWeatherState({ weather: 'snow', rain: dry, snow: 0.7, temperature: -1 })
    expect(state.snowCover).toBeGreaterThan(0.3)
    const opening = state.snowCover
    state.advance(1, 10, true)
    expect(state.snowCover).toBe(opening)
    state.advance(2, 10)
    expect(state.snowCover).toBeGreaterThan(opening)
    expect(new SceneWeatherState({ weather: 'clear', rain: dry }).snowCover).toBe(0)
  })

  it('snaps the cover and the wet air to the weather at once under reduced motion', () => {
    const state = new SceneWeatherState({ weather: 'clear', rain: dry })
    state.set({ weather: 'snow', rain: dry, snow: 0.6 }, 0, 0)
    expect(state.levels.snow).toBe(0.6)
    expect(state.snowCover).toBe(1)
    state.set({ weather: 'overcast', rain: { intensity: 0.4, wind: dry.wind } }, 1, 0)
    expect(state.snowCover).toBe(0)
    expect(state.rainMemory).toBe(0.4)
    // Reduced motion turned on mid-blend lands the refresh and its ground at once.
    state.set({ weather: 'snow', rain: dry, snow: 1 }, 2)
    state.advance(20, 1)
    expect(state.levels.snow).toBeLessThan(1)
    state.settle(21)
    expect(state.blend.transitioning).toBe(false)
    expect(state.levels.snow).toBe(1)
    expect(state.snowCover).toBe(1)
    expect(state.rainMemory).toBe(0)
  })

  it('follows the reported temperature through live refreshes', () => {
    const state = new SceneWeatherState({ weather: 'clear', rain: dry })
    expect(state.measuredTemperature).toBeUndefined()
    expect(state.temperature).toBe(10)
    // Until a report carries a reading, the season's typical temperature melts the snow.
    expect(
      new SceneWeatherState({ weather: 'clear', rain: dry, typicalTemperature: 3 }).temperature,
    ).toBe(3)
    state.set({ weather: 'clear', rain: dry, temperature: 21 }, 0)
    expect(state.measuredTemperature).toBe(21)
    expect(state.temperature).toBe(21)
    // A refresh without a reading, or with a broken one, keeps the last reading.
    state.set({ weather: 'fog', rain: dry, temperature: Number.NaN }, 1)
    state.set({ weather: 'fog', rain: dry }, 2)
    expect(state.measuredTemperature).toBe(21)
    expect(new SceneWeatherState({ weather: 'snow', rain: dry, temperature: -3 })).toMatchObject({
      measuredTemperature: -3,
      temperature: -3,
    })
  })
})

describe('rainbow', () => {
  const low = Math.sin((10 * Math.PI) / 180)
  it('needs a low sun and drops in the air', () => {
    expect(rainbowFactor({ sunHeight: low, rain: 0.4, rainMemory: 0.4 })).toBeCloseTo(1)
    // A dry sky, a sun above 42°, night, a downpour, fog and snow show none.
    expect(rainbowFactor({ sunHeight: low, rain: 0, rainMemory: 0 })).toBe(0)
    expect(rainbowFactor({ sunHeight: Math.sin(0.8), rain: 0.4, rainMemory: 0.4 })).toBe(0)
    expect(rainbowFactor({ sunHeight: -0.1, rain: 0.4, rainMemory: 0.4 })).toBe(0)
    expect(rainbowFactor({ sunHeight: low, rain: 1, rainMemory: 1 })).toBe(0)
    expect(rainbowFactor({ sunHeight: low, rain: 0.4, rainMemory: 0.4, fog: 0.8 })).toBe(0)
    expect(rainbowFactor({ sunHeight: low, rain: 0.4, rainMemory: 0.4, snow: 0.5 })).toBe(0)
    expect(rainbowFactor({ sunHeight: low, rain: 0.4, rainMemory: 0.4, storm: true })).toBeLessThan(
      0.5,
    )
  })

  it('lingers after the rain stops', () => {
    const state = new SceneWeatherState({
      weather: 'cloudy',
      rain: { intensity: 0.4, wind: dry.wind },
    })
    // A one-second change (an instant one is reduced motion's, which snaps the air dry).
    state.set({ weather: 'partly-cloudy', rain: dry }, 0, 1)
    state.advance(1, 1)
    expect(state.levels.rain).toBe(0)
    expect(state.rainbow(low)).toBeGreaterThan(0.9)
    state.advance(600, 600)
    expect(state.rainbow(low)).toBe(0)
  })

  it('is staged in front of the camera, away from the sun, as low as the sun is high', () => {
    const left = new Vector3(-0.3, 0.17, -0.94).normalize()
    const centre = stagedRainbowCentre(left, new Vector3())
    expect(centre.z).toBeLessThan(0)
    expect(centre.x).toBeGreaterThan(0)
    expect(centre.y).toBeCloseTo(-left.y)
    expect(centre.length()).toBeCloseTo(1)
    expect(
      stagedRainbowCentre(new Vector3(0.3, 0.17, -0.94).normalize(), new Vector3()).x,
    ).toBeLessThan(0)
  })

  it('moves continuously while the sun crosses the view in the afternoon', () => {
    const previous = new Vector3(),
      centre = new Vector3()
    let largest = 0,
      crossed = false
    // Minute by minute through the day, wherever a bow may show (the sun 1–40° up).
    for (let s = DEFAULT_SOLAR.sunrise; s < DEFAULT_SOLAR.sunset; s += 60) {
      const sun = sampleLighting(s, 0, 'partly-cloudy').sunDirection
      if (sun.y < 0.015 || sun.y > 0.64) {
        previous.set(0, 0, 0)
        continue
      }
      stagedRainbowCentre(sun, centre)
      if (previous.lengthSq() > 0) {
        largest = Math.max(largest, centre.distanceTo(previous))
        crossed ||= Math.sign(centre.x) !== Math.sign(previous.x)
      }
      previous.copy(centre)
    }
    expect(crossed).toBe(true)
    expect(largest).toBeLessThan(0.02)
    expect(stagedRainbowCentre(new Vector3(Number.NaN, 0.2, -1), centre).x).toBeLessThan(0)
  })
})

describe('snowfall', () => {
  it('drifts with the wind, vanishes at the ground and stops with the snow', () => {
    const snow = new SnowSimulation(() => 0, false, 7)
    snow.setState(1, 3, 0)
    snow.prime()
    const alive = () => snow.flakes.filter((flake) => flake.alive)
    expect(alive().length).toBeGreaterThan(snow.flakes.length * 0.4)
    for (const flake of alive()) expect(flake.y).toBeGreaterThan(0)
    const tracked = alive()[0]
    if (!tracked) throw new Error('No flake')
    const x = tracked.x
    for (let i = 0; i < 60; i++) snow.update(1 / 60)
    expect(!tracked.alive || tracked.x > x).toBe(true)
    for (let i = 0; i < 1200; i++) snow.update(1 / 60)
    for (const flake of alive()) expect(flake.y).toBeGreaterThan(0)
    snow.setState(0, 3, 0)
    expect(alive()).toHaveLength(0)
    expect(new SnowSimulation(() => 0, true, 7).flakes.length).toBeLessThan(snow.flakes.length)
  })

  it('rides a gust push and swerves round the cursor pocket', () => {
    const snow = new SnowSimulation(() => -100, false, 3)
    snow.setState(0.2, 0, 0)
    snow.prime()
    snow.setPush((_x, _z, out) => {
      out[0] = 1
      out[1] = 0
      return 1
    })
    const before = snow.flakes.filter((flake) => flake.alive).map((flake) => flake.vx)
    for (let i = 0; i < 30; i++) snow.update(1 / 30)
    const after = snow.flakes.filter((flake) => flake.alive).map((flake) => flake.vx)
    expect(mean(after)).toBeGreaterThan(mean(before) + 2)
  })
})
