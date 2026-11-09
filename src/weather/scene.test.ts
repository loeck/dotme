import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { required } from '../invariant'
import { fetchWeather } from './current'
import { parisWeatherFixture } from './paris.fixture'
import {
  forcedSceneWeather,
  preloadSceneWeather,
  randomSceneWeather,
  visibilityFog,
  weatherForScene,
} from './scene'
import { fakeAbortTimeouts, memoryStorage } from './timeouts.fixture'

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.useFakeTimers()
  fakeAbortTimeouts()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('localStorage', memoryStorage())
})
afterEach(() => {
  // Both deadlines are AbortSignal.timeout signals: nothing to release, only fakes to clear.
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})
const respond = (data = parisWeatherFixture()) =>
  fetchMock.mockResolvedValue(new Response(JSON.stringify(data)))
const start = (signal = new AbortController().signal) => preloadSceneWeather({ seed: 42, signal })

describe('scene weather mapping', () => {
  it('applies cloud cover, interval-adjusted precipitation and wind direction', async () => {
    const data = parisWeatherFixture()
    Object.assign(data.current, {
      weather_code: 63,
      cloud_cover: 70,
      rain: 1.1,
      wind_speed_10m: 5,
      wind_direction_10m: 90,
    })
    respond(data)
    const mapped = weatherForScene(await fetchWeather())
    expect(mapped.weather).toBe('cloudy')
    expect(mapped.rain.intensity).toBeCloseTo(0.55)
    expect(mapped.rain.wind.x).toBeCloseTo(-5)
    expect(mapped.rain.wind.z).toBeCloseTo(0)
    expect(mapped.wind.meanSpeed).toBe(5)
    expect(mapped.source).toBe('live')
  })
  it('breaks a dry grey deck into clouds but keeps it for rain, fog, snow and storms', async () => {
    for (const [weather_code, rain, expected] of [
      [3, 0, 'cloudy'],
      [3, 1, 'overcast'],
      [45, 0, 'fog'],
      [73, 0, 'snow'],
    ] as const) {
      const data = parisWeatherFixture()
      Object.assign(data.current, { weather_code, cloud_cover: 100, rain })
      respond(data)
      // eslint-disable-next-line no-await-in-loop
      const mapped = weatherForScene(await fetchWeather())
      expect(mapped.weather).toBe(expected)
    }
  })
  it('maps sunrise, sunset and snapshot time to location-local solar seconds', async () => {
    respond()
    const mapped = weatherForScene(await fetchWeather())
    expect(mapped.solar).toEqual({ sunrise: 27_720, sunset: 71_040 })
    expect(mapped.nowSeconds).toBe(36_000)
  })
  it('keeps live weather with a default orbit when the sun never sets or rises', async () => {
    const data = parisWeatherFixture()
    data.daily.sunrise = [1790185440]
    data.daily.sunset = [1790142120]
    respond(data)
    const mapped = weatherForScene(await fetchWeather())
    expect(mapped.source).toBe('live')
    expect(mapped.solar).toEqual({ sunrise: 21_600, sunset: 64_800 })
  })
  it('does not turn snow or a dry thunderstorm into liquid rain', async () => {
    for (const weather_code of [71, 95]) {
      const data = parisWeatherFixture()
      data.current.weather_code = weather_code
      respond(data)
      // Consume each fixture before replacing the response.
      // eslint-disable-next-line no-await-in-loop
      const mapped = weatherForScene(await fetchWeather())
      expect(mapped.weather).toBe(weather_code === 71 ? 'snow' : 'overcast')
      expect(mapped.condition).toBe(weather_code === 71 ? 'snow' : 'thunderstorm')
      expect(mapped.rain.intensity).toBe(0)
      // A dry thunderstorm still brings lightning; snow does not.
      expect(mapped.storm).toBe(weather_code === 95)
    }
  })
  it('keeps fallback presets coherent and repeatable for one visit', () => {
    const presets = new Set<string>()
    for (let seed = 0; seed < 100; seed++) {
      const weather = randomSceneWeather(seed * 10007)
      expect(weather).toEqual(randomSceneWeather(seed * 10007))
      expect(weather.source).toBe('random')
      expect(weather.solar).toEqual({ sunrise: 21_600, sunset: 64_800 })
      expect(weather.nowSeconds).toBeGreaterThanOrEqual(0)
      expect(weather.nowSeconds).toBeLessThan(86_400)
      expect(weather.rain.intensity === 0 || ['cloudy', 'overcast'].includes(weather.weather)).toBe(
        true,
      )
      presets.add(weather.weather)
    }
    expect(presets.size).toBe(4)
  })
})

describe('weather preload deadline', () => {
  it.each([
    ['clear', 'clear', 0, false],
    ['partly-cloudy', 'partly-cloudy', 0, false],
    ['cloudy', 'cloudy', 0, false],
    ['overcast', 'overcast', 0, false],
    ['fog', 'fog', 0, false],
    ['snow', 'snow', 0, false],
    ['rain', 'overcast', 0.55, false],
    ['thunderstorm', 'overcast', 1, true],
  ] as const)('forces %s without fetching live weather', async (weather, sky, intensity, storm) => {
    await expect(
      preloadSceneWeather({ seed: 42, weather, signal: new AbortController().signal }),
    ).resolves.toMatchObject({
      source: 'override',
      weather: sky,
      rain: { intensity },
      storm,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('uses a successful response', async () => {
    respond()
    await expect(start()).resolves.toMatchObject({
      source: 'live',
      weather: 'clear',
      rain: { intensity: 0 },
    })
  })
  it('falls back immediately on HTTP failure or invalid data', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }))
    await expect(start()).resolves.toEqual(randomSceneWeather(42))
    fetchMock.mockResolvedValueOnce(new Response('{}'))
    await expect(start()).resolves.toEqual(randomSceneWeather(42))
  })
  it('falls back at 3 seconds, lets the request finish and caches it for the next visit', async () => {
    // The fallback reads the clock when the deadline fires, the expectation a little later (after
    // waitFor's own fake-clock steps): start on a whole second so both fall in the same one.
    vi.setSystemTime(new Date(1790150400 * 1000 + 60_000))
    let reply: ((response: Response) => void) | undefined
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          reply = resolve
        }),
    )
    const result = start()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const resolved = vi.fn<(result: unknown) => void>()
    void result.then(resolved)
    // waitFor may advance the fake clock while the dynamic module is being imported.
    await vi.advanceTimersByTimeAsync(3000)
    await expect(result).resolves.toEqual(randomSceneWeather(42))
    // The request outlives the scene's deadline, up to its own.
    const request = required(required(required(fetchMock.mock.calls[0])[1]).signal)
    expect(request.aborted).toBe(false)
    required(reply)(new Response(JSON.stringify(parisWeatherFixture())))
    await vi.advanceTimersByTimeAsync(0)
    // The late answer cannot change this scene, but the next one opens on it without a request.
    expect(resolved).toHaveBeenCalledTimes(1)
    await expect(start()).resolves.toMatchObject({ source: 'live', weather: 'clear' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
  it('still bounds a background request by the 10-second deadline', async () => {
    fetchMock.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          const signal = required(required(options).signal)
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
    const result = start()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(3000)
    await expect(result).resolves.toMatchObject({ source: 'random' })
    const request = required(required(required(fetchMock.mock.calls[0])[1]).signal)
    await vi.advanceTimersByTimeAsync(7000)
    expect(request.aborted).toBe(true)
  })
  it('retains the deadline during body parsing', async () => {
    fetchMock.mockImplementation(async (_url, options) =>
      Object.assign(new Response(), {
        json: () =>
          new Promise((_resolve, reject) =>
            required(required(options).signal).addEventListener(
              'abort',
              () => reject(required(required(options).signal).reason),
              {
                once: true,
              },
            ),
          ),
      }),
    )
    const result = start()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(3000)
    await expect(result).resolves.toMatchObject({ source: 'random' })
  })
  it('propagates page disposal rather than choosing random weather', async () => {
    fetchMock.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          required(required(options).signal).addEventListener(
            'abort',
            () => reject(required(required(options).signal).reason),
            {
              once: true,
            },
          )
        }),
    )
    const controller = new AbortController()
    const result = start(controller.signal).catch((error: unknown) => error)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    controller.abort()
    await expect(result).resolves.toMatchObject({ name: 'AbortError' })
  })
})

async function mapSnapshot(current: Partial<ReturnType<typeof parisWeatherFixture>['current']>) {
  const data = parisWeatherFixture()
  Object.assign(data.current, current)
  respond(data)
  return weatherForScene(await fetchWeather())
}

describe('weather conditions for the scene', () => {
  it('keeps heavy-rain codes heavy when the 15-minute amount is small', async () => {
    // 0.1 mm in 15 minutes is 0.4 mm/h, a drizzle by amount; code 65 is heavy rain.
    const heavy = await mapSnapshot({ weather_code: 65, rain: 0.1, cloud_cover: 100 })
    expect(heavy.rain.intensity).toBeCloseTo(0.6)
    expect(heavy.condition).toBe('rain')
    // Measured downpours still win over a light code.
    const measured = await mapSnapshot({ weather_code: 61, rain: 3, cloud_cover: 100 })
    expect(measured.rain.intensity).toBe(1)
  })
  it('maps drizzle, fog and snow to distinct conditions with their own intensities', async () => {
    const drizzle = await mapSnapshot({ weather_code: 53, cloud_cover: 90 })
    expect(drizzle).toMatchObject({ condition: 'drizzle', weather: 'overcast', fog: 0, snow: 0 })
    expect(drizzle.rain.intensity).toBeCloseTo(0.22)
    const fog = await mapSnapshot({ weather_code: 48, cloud_cover: 100, visibility: 150 })
    expect(fog).toMatchObject({ condition: 'fog', weather: 'fog', fog: 1, snow: 0 })
    expect((await mapSnapshot({ weather_code: 45, visibility: 20_000 })).fog).toBe(0.7)
    const snow = await mapSnapshot({ weather_code: 75, snowfall: 0.1, temperature_2m: -3 })
    expect(snow).toMatchObject({ condition: 'snow', weather: 'snow', temperature: -3 })
    expect(snow.snow).toBeCloseTo(0.6)
    expect(snow.rain.intensity).toBe(0)
    const grains = await mapSnapshot({ weather_code: 77 })
    expect(grains.snow).toBeCloseTo(0.2)
    const clear = await mapSnapshot({})
    expect(clear).toMatchObject({ condition: 'dry', fog: 0, snow: 0, temperature: 19.3 })
    expect(clear.humidity).toBeCloseTo(0.61)
  })
  it('reads fog from visibility and turns a dry, very low visibility into the fog preset', async () => {
    expect(visibilityFog(5000)).toBe(0)
    expect(visibilityFog(1000)).toBeCloseTo(0.5)
    expect(visibilityFog(200)).toBeCloseTo(1)
    expect(visibilityFog(0)).toBe(1)
    expect(visibilityFog(Number.NaN)).toBe(0)
    const mist = await mapSnapshot({ weather_code: 3, cloud_cover: 100, visibility: 300 })
    expect(mist).toMatchObject({ weather: 'fog', condition: 'fog' })
    const haze = await mapSnapshot({ weather_code: 3, cloud_cover: 100, visibility: 3000 })
    expect(haze.weather).toBe('cloudy')
    expect(haze.fog).toBeGreaterThan(0)
  })
  it('gives every forced preset a coherent condition', () => {
    expect(forcedSceneWeather(1, 'fog')).toMatchObject({ condition: 'fog', fog: 0.85, snow: 0 })
    expect(forcedSceneWeather(1, 'snow')).toMatchObject({ condition: 'snow', snow: 0.7 })
    expect(forcedSceneWeather(1, 'snow').temperature).toBeLessThan(0)
    expect(forcedSceneWeather(1, 'rain')).toMatchObject({ condition: 'rain', weather: 'overcast' })
    expect(forcedSceneWeather(1, 'thunderstorm')).toMatchObject({
      condition: 'thunderstorm',
      storm: true,
    })
    expect(forcedSceneWeather(1, 'clear')).toMatchObject({ condition: 'dry', fog: 0, snow: 0 })
    // Forced presets are warm enough for crickets, except snow and fog.
    expect(forcedSceneWeather(1, 'clear').temperature).toBeGreaterThan(12)
  })
})
