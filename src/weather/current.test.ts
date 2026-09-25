import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { required } from '../invariant'
import { fetchWeather, interpretWmoCode, WeatherHttpError } from './current'
import { parisWeatherFixture as fixture } from './paris.fixture'

const fetchMock = vi.fn<typeof fetch>()
const respond = (data: unknown = fixture()) =>
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } }),
  )

const pendingFetch = () =>
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

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  // Every outcome must release its timeout.
  // eslint-disable-next-line vitest/no-standalone-expect
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  fetchMock.mockReset()
})

describe('WMO interpretation', () => {
  it.each([
    [[0], 'clear'],
    [[1], 'mainly-clear'],
    [[2], 'partly-cloudy'],
    [[3], 'overcast'],
    [[45, 48], 'fog'],
    [[51, 53, 55, 56, 57], 'drizzle'],
    [[61, 63, 65, 66, 67, 80, 81, 82], 'rain'],
    [[71, 73, 75, 77, 85, 86], 'snow'],
    [[95, 96, 99], 'thunderstorm'],
    [[100, -1, NaN], 'unknown'],
  ] as const)('maps %j to %s', (codes, kind) => {
    for (const code of codes) expect(interpretWmoCode(code).kind).toBe(kind)
  })
  it('retains freezing, rime, hail, showers and snow grains variants', () => {
    for (const code of [56, 57, 66, 67]) expect(interpretWmoCode(code).freezing).toBe(true)
    for (const code of [96, 99]) expect(interpretWmoCode(code).hail).toBe(true)
    for (const code of [80, 81, 82, 85, 86]) expect(interpretWmoCode(code).showers).toBe(true)
    expect(interpretWmoCode(48).rimeFog).toBe(true)
    expect(interpretWmoCode(77).snowGrains).toBe(true)
    expect(interpretWmoCode(95).hail).toBe(false)
    expect(interpretWmoCode(100)).toEqual({
      kind: 'unknown',
      freezing: false,
      hail: false,
      showers: false,
      rimeFog: false,
      snowGrains: false,
    })
  })
})

describe('fetchWeather', () => {
  it('requests custom GPS coordinates and retains the returned local timezone', async () => {
    respond({ ...fixture(), timezone: 'Asia/Singapore', utc_offset_seconds: 28800 })
    const weather = await fetchWeather({ position: { latitude: 1.3521, longitude: 103.8198 } })
    const input = required(fetchMock.mock.calls[0])[0]
    const url = new URL(input instanceof Request ? input.url : input)
    expect(url.searchParams.get('latitude')).toBe('1.3521')
    expect(url.searchParams.get('longitude')).toBe('103.8198')
    expect(url.searchParams.get('timezone')).toBe('auto')
    expect(weather.timezone).toBe('Asia/Singapore')
    expect(weather.utcOffsetSeconds).toBe(28800)
  })

  it('requests Paris with explicit units and preserves numeric values and time metadata', async () => {
    respond()
    const weather = await fetchWeather()
    const input = required(fetchMock.mock.calls[0])[0]
    const url = new URL(input instanceof Request ? input.url : input)
    expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      latitude: '48.8566',
      longitude: '2.3522',
      timezone: 'auto',
      daily: 'sunrise,sunset',
      forecast_days: '1',
      wind_speed_unit: 'ms',
      precipitation_unit: 'mm',
      temperature_unit: 'celsius',
      timeformat: 'unixtime',
    })
    expect(url.searchParams.get('current')?.split(',').toSorted()).toEqual(
      Object.keys(fixture().current)
        .filter((key) => key !== 'time' && key !== 'interval')
        .toSorted(),
    )
    expect(weather).toMatchObject({
      timestampUnixSeconds: 1790150400,
      sunriseUnixSeconds: 1790142120,
      sunsetUnixSeconds: 1790185440,
      intervalSeconds: 900,
      utcOffsetSeconds: 7200,
      timezone: 'Europe/Paris',
      weatherCode: 0,
      isDay: true,
      temperatureC: 19.3,
      apparentTemperatureC: 18.2,
      relativeHumidityPercent: 61,
      visibilityM: 24140,
      windSpeedMs: 3.2,
      windGustsMs: 6.5,
      windDirectionDegrees: 245,
      cloudCoverPercent: 0,
      rainMm: 0,
      showersMm: 0,
      snowfallCm: 0,
      indicators: {
        sunny: true,
        clouds: false,
        rain: false,
        snow: false,
        fog: false,
        thunderstorm: false,
        hail: false,
      },
    })
  })

  it.each([
    ['clear night', { is_day: 0 }, { sunny: false }],
    ['mainly clear day', { weather_code: 1, cloud_cover: 10 }, { sunny: true, clouds: true }],
    ['partial cloud', { weather_code: 2, cloud_cover: 40 }, { sunny: false, clouds: true }],
    ['overcast', { weather_code: 3, cloud_cover: 100 }, { sunny: false, clouds: true }],
    ['rain by code', { weather_code: 61 }, { rain: true, snow: false }],
    ['rain by amount', { weather_code: 3, rain: 0.2 }, { rain: true }],
    ['showers by amount', { weather_code: 3, showers: 0.1 }, { rain: true }],
    ['snow by code', { weather_code: 71 }, { rain: false, snow: true }],
    ['snow by amount', { weather_code: 3, snowfall: 0.3 }, { snow: true }],
    [
      'mixed precipitation',
      { weather_code: 71, rain: 0.2, snowfall: 0.4 },
      { rain: true, snow: true },
    ],
    ['fog', { weather_code: 45 }, { fog: true, sunny: false }],
    ['freezing drizzle', { weather_code: 56 }, { rain: true, snow: false }],
    ['freezing rain', { weather_code: 67 }, { rain: true }],
    ['thunderstorm', { weather_code: 95 }, { thunderstorm: true, hail: false }],
    ['hail', { weather_code: 99, rain: 0.5 }, { thunderstorm: true, hail: true, rain: true }],
    ['unknown', { weather_code: 123 }, { sunny: false, rain: false, snow: false }],
    [
      'unknown with precipitation',
      { weather_code: 123, rain: 0.2, snowfall: 0.1 },
      { sunny: false, rain: true, snow: true },
    ],
  ])('interprets %s without exclusive precipitation flags', async (_name, current, indicators) => {
    const data = fixture()
    Object.assign(data.current, current)
    respond(data)
    const weather = await fetchWeather()
    expect(weather.indicators).toMatchObject(indicators)
    expect(weather.weatherCode).toBe(data.current.weather_code)
  })

  it.each(Object.keys(fixture().current))('rejects absent/null required %s', async (key) => {
    for (const value of [undefined, null]) {
      const data = fixture()
      Object.assign(data.current, { [key]: value })
      respond(data)
      // Each fixture is consumed before replacing the mock response.
      // eslint-disable-next-line no-await-in-loop
      await expect(fetchWeather()).rejects.toThrow(TypeError)
    }
  })
  it.each([
    ['cloud_cover', 101],
    ['relative_humidity_2m', -1],
    ['wind_speed_10m', -1],
    ['wind_gusts_10m', -1],
    ['wind_direction_10m', 361],
    ['is_day', 2],
    ['rain', -0.1],
    ['snowfall', -0.1],
    ['showers', -0.1],
    ['visibility', -1],
    ['temperature_2m', '19'],
    ['apparent_temperature', -274],
    ['weather_code', 1.5],
    ['time', '2026-09-23T12:00'],
    ['interval', 0],
    ['interval', 0.5],
  ])('rejects invalid %s = %s', async (key, value) => {
    const data = fixture()
    Object.assign(data.current, { [key]: value })
    respond(data)
    await expect(fetchWeather()).rejects.toThrow(TypeError)
  })
  it.each([
    null,
    [],
    {},
    { current: {} },
    { ...fixture(), timezone: 'Invalid/Timezone' },
    { ...fixture(), utc_offset_seconds: null },
    { ...fixture(), current_units: {} },
    { ...fixture(), current_units: { ...fixture().current_units, wind_speed_10m: 'km/h' } },
    { ...fixture(), daily: undefined },
    { ...fixture(), daily_units: undefined },
    { ...fixture(), daily_units: { ...fixture().daily_units, sunrise: 'iso8601' } },
    { ...fixture(), daily: { ...fixture().daily, sunrise: [] } },
    { ...fixture(), daily: { ...fixture().daily, sunset: [1790185440.5] } },
    { ...fixture(), daily: { ...fixture().daily, sunrise: ['1790142120'] } },
  ])('rejects malformed data/metadata %#', async (data) => {
    respond(data)
    await expect(fetchWeather()).rejects.toThrow(TypeError)
  })
  it('rejects non-finite values without coercion', async () => {
    fetchMock.mockResolvedValue(
      Object.assign(new Response(), {
        json: async () => ({ ...fixture(), current: { ...fixture().current, rain: Infinity } }),
      }),
    )
    await expect(fetchWeather()).rejects.toThrow(TypeError)
  })
  it('preserves HTTP status', async () => {
    fetchMock.mockResolvedValue(new Response('Unavailable', { status: 503 }))
    await expect(fetchWeather()).rejects.toMatchObject({
      name: 'WeatherHttpError',
      status: 503,
    })
    expect(new WeatherHttpError(429)).toBeInstanceOf(Error)
  })
  it('propagates network and JSON errors', async () => {
    const error = new TypeError('Network unavailable')
    fetchMock.mockRejectedValueOnce(error)
    await expect(fetchWeather()).rejects.toBe(error)
    fetchMock.mockResolvedValueOnce(new Response('{'))
    await expect(fetchWeather()).rejects.toThrow(SyntaxError)
  })

  it('aborts a stalled request after exactly 10 seconds', async () => {
    pendingFetch()
    const result = fetchWeather().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(9999)
    expect(required(required(required(fetchMock.mock.calls[0])[1]).signal).aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(result).resolves.toMatchObject({ name: 'TimeoutError' })
  })
  it('keeps the timeout active while reading the body', async () => {
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
    const result = fetchWeather().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(result).resolves.toMatchObject({ name: 'TimeoutError' })
  })
  it('rejects already aborted requests without fetching', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(fetchWeather({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('forwards caller cancellation and removes its listener', async () => {
    pendingFetch()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const reason = new Error('Stopped')
    const result = fetchWeather({ signal: controller.signal }).catch((error: unknown) => error)
    controller.abort(reason)
    await expect(result).resolves.toBe(reason)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
  it('removes listeners after success', async () => {
    respond()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    await fetchWeather({ signal: controller.signal })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    controller.abort()
    expect(required(required(required(fetchMock.mock.calls[0])[1]).signal).aborted).toBe(false)
  })
})
