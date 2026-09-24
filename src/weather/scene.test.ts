import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchWeather } from './current'
import { parisWeatherFixture } from './paris.fixture'
import { preloadSceneWeather, randomSceneWeather, weatherForScene } from './scene'

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  // Every completion releases both the preload and HTTP deadlines.
  // eslint-disable-next-line vitest/no-standalone-expect
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
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
  it('does not turn snow or a dry thunderstorm into liquid rain', async () => {
    for (const weather_code of [71, 95]) {
      const data = parisWeatherFixture()
      data.current.weather_code = weather_code
      respond(data)
      // Consume each fixture before replacing the response.
      // eslint-disable-next-line no-await-in-loop
      const mapped = weatherForScene(await fetchWeather())
      expect(mapped.weather).toBe('overcast')
      expect(mapped.rain.intensity).toBe(0)
    }
  })
  it('keeps fallback presets coherent and repeatable for one visit', () => {
    const presets = new Set<string>()
    for (let seed = 0; seed < 100; seed++) {
      const weather = randomSceneWeather(seed * 10007)
      expect(weather).toEqual(randomSceneWeather(seed * 10007))
      expect(weather.source).toBe('random')
      expect(weather.rain.intensity === 0 || ['cloudy', 'overcast'].includes(weather.weather)).toBe(
        true,
      )
      presets.add(weather.weather)
    }
    expect(presets.size).toBe(4)
  })
})

describe('weather preload deadline', () => {
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
  it('aborts at 3 seconds and ignores a late response even if fetch ignores cancellation', async () => {
    let reply!: (response: Response) => void
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
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true)
    reply(new Response(JSON.stringify(parisWeatherFixture())))
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toHaveBeenCalledTimes(1)
  })
  it('retains the deadline during body parsing', async () => {
    fetchMock.mockImplementation(
      async (_url, options) =>
        ({
          ok: true,
          json: () =>
            new Promise((_resolve, reject) =>
              options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), {
                once: true,
              }),
            ),
        }) as Response,
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
          options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), {
            once: true,
          })
        }),
    )
    const controller = new AbortController()
    const result = start(controller.signal).catch((error: unknown) => error)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    controller.abort()
    await expect(result).resolves.toMatchObject({ name: 'AbortError' })
  })
})
