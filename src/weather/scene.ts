import type { GpsPosition } from '../scene-params'
import type { RainState } from '../scene/rain-simulation'
import type { WeatherPreset } from '../scene/weather'
import type { WindOptions } from '../scene/wind'
import type { WeatherSnapshot } from './current'

export const WEATHER_PRELOAD_TIMEOUT_MS = 3000

export type SceneWeather = Readonly<{
  weather: WeatherPreset
  rain: RainState
  wind: WindOptions
  source: 'live' | 'random'
}>

/** Artistic presets, not a physical precipitation or cloud simulation. */
export function weatherForScene(snapshot: WeatherSnapshot): SceneWeather {
  const { kind } = snapshot.condition
  const cover = snapshot.cloudCoverPercent
  let weather: WeatherPreset =
    cover < 20 ? 'clear' : cover < 55 ? 'partly-cloudy' : cover < 85 ? 'cloudy' : 'overcast'
  if (['overcast', 'fog', 'snow', 'thunderstorm'].includes(kind)) weather = 'overcast'
  if (['rain', 'drizzle'].includes(kind) && cover < 55) weather = 'cloudy'

  // API amounts are accumulated over the reported interval, not mm/hour.
  const rate = ((snapshot.rainMm + snapshot.showersMm) * 3600) / snapshot.intervalSeconds
  const codeIntensity: Record<number, number> = {
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
  const intensity =
    rate > 0 ? Math.min(1, Math.max(0.12, rate / 8)) : (codeIntensity[snapshot.weatherCode] ?? 0)
  if (intensity > 0 && ['clear', 'partly-cloudy'].includes(weather)) weather = 'cloudy'
  // Meteorological bearings describe where wind comes from. Scene +z is south.
  const direction = (snapshot.windDirectionDegrees * Math.PI) / 180
  const speed = Math.min(20, snapshot.windSpeedMs)
  return {
    weather,
    rain: { intensity, wind: { x: -Math.sin(direction) * speed, z: Math.cos(direction) * speed } },
    wind: {
      bearing: Math.atan2(Math.cos(direction), -Math.sin(direction)),
      meanSpeed: Math.min(8, speed),
      gustStrength:
        speed > 0 ? Math.min(1, Math.max(0, snapshot.windGustsMs / speed - 1) / 0.43) : 0,
      turnStrength: 0.15,
    },
    source: 'live',
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
  const [weather, intensity] = presets[Math.floor(random() * presets.length)]!
  const angle = random() * Math.PI * 2
  const speed = 1 + random() * 4
  return {
    weather,
    rain: { intensity, wind: { x: Math.cos(angle) * speed, z: Math.sin(angle) * speed } },
    wind: { bearing: angle, meanSpeed: speed },
    source: 'random',
  }
}

export async function preloadSceneWeather({
  seed,
  position,
  signal,
  timeoutMs = WEATHER_PRELOAD_TIMEOUT_MS,
}: {
  seed: number
  position?: GpsPosition
  signal: AbortSignal
  timeoutMs?: number
}): Promise<SceneWeather> {
  signal.throwIfAborted()
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Weather preload timed out', 'TimeoutError')),
    timeoutMs,
  )
  let onAbort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(controller.signal.reason)
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    // The deadline covers the module download, fetch, body read and parsing.
    const request = import('./current').then(async ({ fetchWeather }) => {
      controller.signal.throwIfAborted()
      return weatherForScene(await fetchWeather({ position, signal: controller.signal }))
    })
    return await Promise.race([request, cancelled])
  } catch {
    signal.throwIfAborted()
    return randomSceneWeather(seed)
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
    controller.signal.removeEventListener('abort', onAbort)
  }
}
