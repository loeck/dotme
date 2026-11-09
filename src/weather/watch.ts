import type { GpsPosition, WeatherOverride } from '../scene-params'
import { fetchWeather } from './current'
import { weatherForScene } from './scene'
import type { SceneWeather } from './scene'

/** Open-Meteo's current conditions advance in 15-minute slots, aligned to UTC. */
export const WEATHER_SLOT_MS = 15 * 60 * 1000
/** Wait this long past a slot boundary, so the new slot is published before asking for it. */
export const WEATHER_SLOT_SETTLE_MS = 60 * 1000
/** After a failed preload (random weather), the first live attempt comes this soon. */
export const WEATHER_RETRY_MS = 60 * 1000

export type WatchSceneWeatherOptions = Readonly<{
  position?: GpsPosition
  /** A forced `?weather=` preset: nothing is watched. */
  weather?: WeatherOverride
  /** The weather the scene opened with, so its own slot is not reported again. */
  current?: SceneWeather
  /** Whether the page is visible; defaults to `!document.hidden`. */
  visible?: () => boolean
}>

/** Milliseconds from `now` (Unix ms) until the next slot has settled. */
export function nextWeatherSlotDelay(now: number) {
  const settled = Math.floor(now / WEATHER_SLOT_MS) * WEATHER_SLOT_MS + WEATHER_SLOT_SETTLE_MS
  return (settled > now ? settled : settled + WEATHER_SLOT_MS) - now
}

/**
 * Keeps live weather current through a long visit: once each 15-minute slot, while the page is
 * visible, it fetches the slot's conditions (through `fetchWeather`, so a reload in the same
 * slot reuses the cache) and calls `onChange` with the new scene weather. A hidden page skips
 * slots and catches up once when it becomes visible again. Failures are silent and retried at
 * the next slot; `onChange` never receives random or forced weather. Forced weather watches
 * nothing. Aborting `signal` stops the watch and cancels any request in flight.
 */
export function watchSceneWeather(
  options: WatchSceneWeatherOptions,
  onChange: (weather: SceneWeather) => void,
  signal: AbortSignal,
) {
  if (options.weather || signal.aborted) return
  const visible = options.visible ?? (() => typeof document === 'undefined' || !document.hidden)
  // Scene weather from one slot always maps to the same local time; a new slot moves it.
  let reported = options.current?.source === 'live' ? options.current.nowSeconds : undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let missed = false
  let busy = false

  const schedule = (delay: number) => {
    clearTimeout(timer)
    timer = setTimeout(() => void refresh(), delay)
  }
  const refresh = async () => {
    if (signal.aborted || busy) return
    if (!visible()) {
      missed = true
      return
    }
    busy = true
    try {
      const weather = weatherForScene(
        await fetchWeather({ ...(options.position ? { position: options.position } : {}), signal }),
      )
      if (!signal.aborted && weather.nowSeconds !== reported) {
        reported = weather.nowSeconds
        onChange(weather)
      }
    } catch {
      /* Offline, rate-limited or invalid: the scene keeps its weather until the next slot. */
    } finally {
      busy = false
    }
    if (!signal.aborted) schedule(nextWeatherSlotDelay(Date.now()))
  }

  if (typeof document !== 'undefined')
    document.addEventListener(
      'visibilitychange',
      () => {
        if (!missed || !visible()) return
        missed = false
        void refresh()
      },
      { signal },
    )
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  const delay = nextWeatherSlotDelay(Date.now())
  schedule(reported === undefined ? Math.min(delay, WEATHER_RETRY_MS) : delay)
}
