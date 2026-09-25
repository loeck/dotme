import { PARIS } from '../scene-params'
import type { GpsPosition } from '../scene-params'

export type WeatherKind =
  | 'clear'
  | 'mainly-clear'
  | 'partly-cloudy'
  | 'overcast'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'snow'
  | 'thunderstorm'
  | 'unknown'

export interface WmoCondition {
  kind: WeatherKind
  freezing: boolean
  hail: boolean
  showers: boolean
  rimeFog: boolean
  snowGrains: boolean
}

/** Interpret Open-Meteo's WMO codes; unrecognized codes never imply clear weather. */
export function interpretWmoCode(code: number): WmoCondition {
  let kind: WeatherKind = 'unknown'
  if (code === 0) kind = 'clear'
  else if (code === 1) kind = 'mainly-clear'
  else if (code === 2) kind = 'partly-cloudy'
  else if (code === 3) kind = 'overcast'
  else if ([45, 48].includes(code)) kind = 'fog'
  else if ([51, 53, 55, 56, 57].includes(code)) kind = 'drizzle'
  else if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) kind = 'rain'
  else if ([71, 73, 75, 77, 85, 86].includes(code)) kind = 'snow'
  else if ([95, 96, 99].includes(code)) kind = 'thunderstorm'
  return {
    kind,
    freezing: [56, 57, 66, 67].includes(code),
    hail: code === 96 || code === 99,
    showers: [80, 81, 82, 85, 86].includes(code),
    rimeFog: code === 48,
    snowGrains: code === 77,
  }
}

export interface WeatherSnapshot {
  timezone: string
  /** Original API time, explicitly requested as UTC Unix seconds (no local-date parsing). */
  timestampUnixSeconds: number
  /** Today's sunrise/sunset for the requested position, as UTC Unix seconds. */
  sunriseUnixSeconds: number
  sunsetUnixSeconds: number
  utcOffsetSeconds: number
  /** Duration of backward-looking sums/averages, in seconds. Usually 900. */
  intervalSeconds: number
  weatherCode: number
  isDay: boolean
  temperatureC: number
  apparentTemperatureC: number
  relativeHumidityPercent: number
  visibilityM: number
  windSpeedMs: number
  windGustsMs: number
  windDirectionDegrees: number
  cloudCoverPercent: number
  /** Accumulations over intervalSeconds, NOT instantaneous rates. */
  rainMm: number
  showersMm: number
  snowfallCm: number
  condition: WmoCondition
  indicators: {
    /** Approximation: daylight and WMO 0 or 1; not measured sunshine. */
    sunny: boolean
    clouds: boolean
    rain: boolean
    snow: boolean
    fog: boolean
    thunderstorm: boolean
    hail: boolean
  }
}

const UNITS = {
  temperature_2m: '°C',
  apparent_temperature: '°C',
  relative_humidity_2m: '%',
  visibility: 'm',
  wind_speed_10m: 'm/s',
  wind_gusts_10m: 'm/s',
  wind_direction_10m: '°',
  cloud_cover: '%',
  rain: 'mm',
  showers: 'mm',
  snowfall: 'cm',
  weather_code: 'wmo code',
  is_day: '',
} as const

const DAILY_UNITS = {
  time: 'unixtime',
  sunrise: 'unixtime',
  sunset: 'unixtime',
} as const

const MAX_UNIX_SECONDS = 8_640_000_000_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`Invalid weather data: ${field}`)
  }
  return value
}

function number(
  data: Record<string, unknown>,
  key: string,
  minimum = -Infinity,
  maximum = Infinity,
  integer = false,
): number {
  const value = data[key]
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum ||
    (integer && !Number.isSafeInteger(value))
  ) {
    throw new TypeError(`Invalid weather data: ${key}`)
  }
  return value
}

function dailyUnix(data: Record<string, unknown>, key: string): number {
  const value = data[key]
  if (!Array.isArray(value) || value.length < 1) throw new TypeError(`Invalid weather data: ${key}`)
  const first: unknown = value[0]
  if (
    typeof first !== 'number' ||
    !Number.isSafeInteger(first) ||
    first < 0 ||
    first > MAX_UNIX_SECONDS
  ) {
    throw new TypeError(`Invalid weather data: ${key}`)
  }
  return first
}

function parseWeatherSnapshot(value: unknown): WeatherSnapshot {
  const data = object(value, 'response')
  const current = object(data.current, 'current')
  const units = object(data.current_units, 'current_units')
  for (const [key, unit] of Object.entries({ ...UNITS, time: 'unixtime', interval: 'seconds' })) {
    if (units[key] !== unit) throw new TypeError(`Invalid weather unit: ${key}`)
  }
  const daily = object(data.daily, 'daily')
  const dailyUnits = object(data.daily_units, 'daily_units')
  for (const [key, unit] of Object.entries(DAILY_UNITS)) {
    if (dailyUnits[key] !== unit) throw new TypeError(`Invalid weather unit: daily_${key}`)
  }
  if (typeof data.timezone !== 'string' || !data.timezone)
    throw new TypeError('Invalid weather timezone')
  try {
    new Intl.DateTimeFormat('en', { timeZone: data.timezone }).format(0)
  } catch {
    throw new TypeError('Invalid weather timezone')
  }
  const weatherCode = number(current, 'weather_code', 0, Infinity, true)
  const isDay = number(current, 'is_day', 0, 1, true) === 1
  const cloudCoverPercent = number(current, 'cloud_cover', 0, 100)
  const rainMm = number(current, 'rain', 0)
  const showersMm = number(current, 'showers', 0)
  const snowfallCm = number(current, 'snowfall', 0)
  const condition = interpretWmoCode(weatherCode)
  return {
    timezone: data.timezone,
    timestampUnixSeconds: number(current, 'time', 0, MAX_UNIX_SECONDS, true),
    sunriseUnixSeconds: dailyUnix(daily, 'sunrise'),
    sunsetUnixSeconds: dailyUnix(daily, 'sunset'),
    utcOffsetSeconds: number(data, 'utc_offset_seconds', -86_400, 86_400, true),
    intervalSeconds: number(current, 'interval', 1, Infinity, true),
    weatherCode,
    isDay,
    temperatureC: number(current, 'temperature_2m', -273.15),
    apparentTemperatureC: number(current, 'apparent_temperature', -273.15),
    relativeHumidityPercent: number(current, 'relative_humidity_2m', 0, 100),
    visibilityM: number(current, 'visibility', 0),
    windSpeedMs: number(current, 'wind_speed_10m', 0),
    windGustsMs: number(current, 'wind_gusts_10m', 0),
    windDirectionDegrees: number(current, 'wind_direction_10m', 0, 360),
    cloudCoverPercent,
    rainMm,
    showersMm,
    snowfallCm,
    condition,
    indicators: {
      sunny: isDay && (weatherCode === 0 || weatherCode === 1),
      clouds: cloudCoverPercent > 0,
      rain:
        rainMm > 0 || showersMm > 0 || condition.kind === 'rain' || condition.kind === 'drizzle',
      snow: snowfallCm > 0 || condition.kind === 'snow',
      fog: condition.kind === 'fog',
      thunderstorm: condition.kind === 'thunderstorm',
      hail: condition.hail,
    },
  }
}

export class WeatherHttpError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`Open-Meteo request failed (HTTP ${status})`)
    this.name = 'WeatherHttpError'
    this.status = status
  }
}

/** On-demand only. Free API: non-commercial use; attribute Open-Meteo when integrating data. */
export async function fetchWeather({
  signal,
  position = PARIS,
}: { signal?: AbortSignal; position?: GpsPosition } = {}): Promise<WeatherSnapshot> {
  signal?.throwIfAborted()
  if (
    !Number.isFinite(position.latitude) ||
    !Number.isFinite(position.longitude) ||
    Math.abs(position.latitude) > 90 ||
    Math.abs(position.longitude) > 180
  )
    throw new TypeError('Invalid weather position')
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => {
    controller.abort(
      new DOMException('Open-Meteo request timed out after 10 seconds', 'TimeoutError'),
    )
  }, 10_000)
  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast')
    url.search = new URLSearchParams({
      latitude: String(position.latitude),
      longitude: String(position.longitude),
      timezone: 'auto',
      current: Object.keys(UNITS).join(','),
      daily: 'sunrise,sunset',
      forecast_days: '1',
      wind_speed_unit: 'ms',
      temperature_unit: 'celsius',
      precipitation_unit: 'mm',
      timeformat: 'unixtime',
    }).toString()
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new WeatherHttpError(response.status)
    const data: unknown = await response.json()
    controller.signal.throwIfAborted()
    return parseWeatherSnapshot(data)
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}
