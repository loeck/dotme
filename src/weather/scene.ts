import { required } from '../invariant'
import type { GpsPosition, WeatherOverride } from '../scene-params'
import type { RainState } from '../scene/rain-simulation'
import { DEFAULT_SOLAR, parseInitialTime } from '../scene/solar-clock'
import type { SolarEndpoints } from '../scene/solar-clock'
import type { WeatherPreset } from '../scene/weather'
import type { WindOptions } from '../scene/wind'
import type { WeatherSnapshot } from './current'
import { anySignal, untilAborted } from './signals'

const WEATHER_PRELOAD_TIMEOUT_MS = 3000

/**
 * The precipitation or obscuration the scene is in, independent of the sky preset: drizzle,
 * fog and snow are distinct from rain even where the scene does not draw them yet.
 */
type SceneCondition = 'dry' | 'drizzle' | 'rain' | 'fog' | 'snow' | 'thunderstorm'

export type SceneWeather = Readonly<{
  weather: WeatherPreset
  condition: SceneCondition
  rain: RainState
  /** 0–1: fog density, from the WMO fog codes and reported visibility. */
  fog: number
  /** 0–1: snowfall intensity, from reported snowfall and WMO snow codes. */
  snow: number
  /** Air temperature at 2 m, °C. */
  temperature: number
  /** Relative humidity at 2 m, 0–1. */
  humidity: number
  wind: WindOptions
  solar: SolarEndpoints
  /** Location-local seconds past midnight at the snapshot time. */
  nowSeconds: number
  source: 'live' | 'random' | 'override'
  /** A thunderstorm is reported: the scene adds lightning, whatever the rain. */
  storm?: boolean
}>

/** Artistic rain intensity of the WMO drizzle and rain codes. */
const RAIN_CODES: Readonly<Record<number, number>> = {
  51: 0.15,
  53: 0.22,
  55: 0.3,
  56: 0.15,
  57: 0.3,
  61: 0.25,
  63: 0.55,
  65: 1,
  66: 0.25,
  67: 0.75,
  80: 0.25,
  81: 0.55,
  82: 1,
}
/** Artistic snow intensity of the WMO snow codes (77 is snow grains). */
const SNOW_CODES: Readonly<Record<number, number>> = {
  71: 0.3,
  73: 0.6,
  75: 1,
  77: 0.2,
  85: 0.4,
  86: 0.9,
}

/**
 * Intensity from a measured hourly rate and the reported code. Fifteen-minute model amounts lag
 * and understate a heavy shower the code already names, so the code sets a floor of 60% of its
 * own intensity: a downpour code never plays as drizzle.
 */
function precipitation(ratePerHour: number, saturation: number, code: number | undefined) {
  const coded = code ?? 0
  if (ratePerHour <= 0) return coded
  return Math.max(Math.min(1, Math.max(0.12, ratePerHour / saturation)), coded * 0.6)
}

/** Fog from visibility: none at 5 km, half at 1 km (the fog threshold), dense at 200 m. */
export function visibilityFog(visibilityM: number) {
  if (!Number.isFinite(visibilityM)) return 0
  const fog = Math.log(5000 / Math.max(1, visibilityM)) / Math.log(5000 / 200)
  return Math.max(0, Math.min(1, fog))
}

/** Artistic presets, not a physical precipitation or cloud simulation. */
export function weatherForScene(snapshot: WeatherSnapshot): SceneWeather {
  const { kind, rimeFog } = snapshot.condition
  const cover = snapshot.cloudCoverPercent
  let weather: WeatherPreset =
    cover < 20 ? 'clear' : cover < 55 ? 'partly-cloudy' : cover < 85 ? 'cloudy' : 'overcast'
  if (['overcast', 'thunderstorm'].includes(kind)) weather = 'overcast'
  if (['rain', 'drizzle'].includes(kind) && cover < 55) weather = 'cloudy'

  // API amounts are accumulated over the reported interval, not mm (or cm) per hour.
  const perHour = 3600 / snapshot.intervalSeconds
  const intensity = precipitation(
    (snapshot.rainMm + snapshot.showersMm) * perHour,
    8,
    RAIN_CODES[snapshot.weatherCode],
  )
  const snow = precipitation(snapshot.snowfallCm * perHour, 2.5, SNOW_CODES[snapshot.weatherCode])
  const fog = Math.max(
    kind === 'fog' ? (rimeFog ? 0.8 : 0.7) : 0,
    visibilityFog(snapshot.visibilityM),
  )
  if (intensity > 0 && ['clear', 'partly-cloudy'].includes(weather)) weather = 'cloudy'
  // A dry grey sky is the dullest frame the scene can open on: it keeps its cloud but breaks
  // up, so the light still finds the lake. Rain, fog, snow and storms keep their full deck.
  const dry = !['fog', 'snow', 'thunderstorm', 'rain', 'drizzle'].includes(kind)
  if (weather === 'overcast' && intensity === 0 && dry) weather = 'cloudy'
  // Fog and snow have presets of their own, with a full deck; so does a dry, very low visibility.
  if (kind === 'snow' || (snow > 0 && intensity === 0)) weather = 'snow'
  else if (kind === 'fog' || (fog >= 0.75 && intensity === 0 && dry)) weather = 'fog'
  const condition: SceneCondition =
    kind === 'thunderstorm'
      ? 'thunderstorm'
      : weather === 'snow'
        ? 'snow'
        : kind === 'drizzle'
          ? 'drizzle'
          : intensity > 0
            ? 'rain'
            : weather === 'fog'
              ? 'fog'
              : 'dry'
  // Meteorological bearings describe where wind comes from. Scene +z is south.
  const direction = (snapshot.windDirectionDegrees * Math.PI) / 180
  const speed = Math.min(20, snapshot.windSpeedMs)
  const clock = new Intl.DateTimeFormat('en', {
    timeZone: snapshot.timezone,
    hourCycle: 'h23',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  })
  const secondsOfDay = (timestampUnixSeconds: number) => {
    const parts = clock.formatToParts(new Date(timestampUnixSeconds * 1000))
    const value = (type: string) => Number(required(parts.find((part) => part.type === type)).value)
    return value('hour') * 3600 + value('minute') * 60 + value('second')
  }
  const sunrise = secondsOfDay(snapshot.sunriseUnixSeconds)
  const sunset = secondsOfDay(snapshot.sunsetUnixSeconds)
  return {
    weather,
    condition,
    fog,
    snow,
    temperature: snapshot.temperatureC,
    humidity: snapshot.relativeHumidityPercent / 100,
    solar: sunset > sunrise ? { sunrise, sunset } : DEFAULT_SOLAR,
    nowSeconds: secondsOfDay(snapshot.timestampUnixSeconds),
    rain: { intensity, wind: { x: -Math.sin(direction) * speed, z: Math.cos(direction) * speed } },
    wind: {
      bearing: Math.atan2(Math.cos(direction), -Math.sin(direction)),
      meanSpeed: Math.min(8, speed),
      gustStrength:
        speed > 0 ? Math.min(1, Math.max(0, snapshot.windGustsMs / speed - 1) / 0.43) : 0,
      gustSpeed: Math.min(12, snapshot.windGustsMs),
      turnStrength: 0.15,
    },
    source: 'live',
    storm: kind === 'thunderstorm',
  }
}

/** Seeded per visit so restarts and bfcache keep the same fallback. */
export function randomSceneWeather(seed: number): SceneWeather {
  let value = (seed ^ 0x9e3779b9) >>> 0
  const random = () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0
    return value / 0x1_0000_0000
  }
  const presets: readonly (readonly [WeatherPreset, number])[] = [
    ['clear', 0],
    ['partly-cloudy', 0],
    ['cloudy', 0],
    ['overcast', 0],
    ['cloudy', 0.25],
    ['overcast', 0.55],
    ['overcast', 1],
  ]
  const [weather, intensity] = required(presets[Math.floor(random() * presets.length)])
  const angle = random() * Math.PI * 2
  const speed = 1 + random() * 4
  return {
    weather,
    condition: intensity > 0 ? 'rain' : 'dry',
    fog: 0,
    snow: 0,
    // A mild, slightly damp default: warm enough for crickets.
    temperature: 16,
    humidity: intensity > 0 ? 0.9 : 0.7,
    solar: DEFAULT_SOLAR,
    nowSeconds: parseInitialTime(null),
    rain: { intensity, wind: { x: Math.cos(angle) * speed, z: Math.sin(angle) * speed } },
    wind: { bearing: angle, meanSpeed: speed },
    source: 'random',
  }
}

/** Forced `?weather=` presets: no request, seeded wind, artistic values for each condition. */
export function forcedSceneWeather(seed: number, weather: WeatherOverride): SceneWeather {
  const preset = randomSceneWeather(seed)
  const rain = weather === 'thunderstorm' ? 1 : weather === 'rain' ? 0.55 : 0
  const base = {
    ...preset,
    rain: { ...preset.rain, intensity: rain },
    storm: weather === 'thunderstorm',
    source: 'override',
    fog: 0,
    snow: 0,
    temperature: 18,
    humidity: rain > 0 ? 0.9 : 0.6,
  } as const
  if (weather === 'rain' || weather === 'thunderstorm')
    return { ...base, weather: 'overcast', condition: weather === 'rain' ? 'rain' : weather }
  if (weather === 'fog')
    return { ...base, weather, condition: 'fog', fog: 0.85, temperature: 9, humidity: 0.97 }
  if (weather === 'snow')
    return { ...base, weather, condition: 'snow', snow: 0.7, temperature: -1, humidity: 0.9 }
  return { ...base, weather, condition: 'dry' }
}

export async function preloadSceneWeather({
  seed,
  position,
  weather,
  signal,
  timeoutMs = WEATHER_PRELOAD_TIMEOUT_MS,
}: {
  seed: number
  position?: GpsPosition
  weather?: WeatherOverride
  signal: AbortSignal
  timeoutMs?: number
}): Promise<SceneWeather> {
  signal.throwIfAborted()
  if (weather) return forcedSceneWeather(seed, weather)
  // The request is bounded by the page and by fetchWeather's own 10-second deadline, not by
  // the scene's: an answer that misses the scene still lands in the cache for the next visit.
  const request = import('./current').then(({ fetchWeather }) =>
    fetchWeather({ ...(position ? { position } : {}), signal }),
  )
  request.catch(() => {})
  try {
    // The scene deadline covers the module download, fetch, body read and parsing.
    const deadline = anySignal([signal, AbortSignal.timeout(timeoutMs)])
    return weatherForScene(await untilAborted(request, deadline))
  } catch {
    signal.throwIfAborted()
    return randomSceneWeather(seed)
  }
}
