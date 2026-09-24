import type { VoxelLandscapeEngine } from '../scene/VoxelLandscapeEngine'
import { parseWeather } from '../scene/weather'
import { preloadSceneWeather } from '../weather/scene'
import type { SceneWeather } from '../weather/scene'

function querySeed(search: string): number | undefined {
  const value = new URLSearchParams(search).get('seed')
  if (!value || !/^(?:0|[1-9]\d{0,9})$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed <= 0xffff_ffff ? parsed >>> 0 : undefined
}

function randomSeed(): number {
  return globalThis.crypto?.getRandomValues
    ? globalThis.crypto.getRandomValues(new Uint32Array(1))[0]!
    : Math.floor(Math.random() * 0x1_0000_0000)
}

// Keep a page's composition when its DOM is restored from the back/forward cache.
const seeds = new WeakMap<HTMLDivElement, number>()
const weatherSnapshots = new WeakMap<HTMLDivElement, SceneWeather>()

export function initLandscape(host: HTMLDivElement, onSettled: () => void = () => {}): () => void {
  const lifetime = new AbortController()
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const seed = seeds.get(host) ?? querySeed(window.location.search) ?? randomSeed()
  seeds.set(host, seed)
  let engine: VoxelLandscapeEngine | undefined
  let preparation: AbortController | undefined
  let resizeObserver: ResizeObserver | undefined

  const stop = () => {
    preparation?.abort()
    preparation = undefined
    resizeObserver?.disconnect()
    resizeObserver = undefined
    engine?.dispose()
    engine = undefined
    host.classList.replace('opacity-100', 'opacity-0')
  }

  const start = async () => {
    try {
      const params = new URLSearchParams(window.location.search)
      // Explicit visual previews stay deterministic and do not need a forecast.
      const manual = params.has('weather') || params.has('rain')
      const [{ VoxelLandscapeEngine: Engine }, { queryRainState }, snapshot] = await Promise.all([
        import('../scene/VoxelLandscapeEngine'),
        import('../scene/rain-simulation'),
        manual
          ? undefined
          : (weatherSnapshots.get(host) ?? preloadSceneWeather({ seed, signal: lifetime.signal })),
      ])
      if (lifetime.signal.aborted) return
      if (snapshot) weatherSnapshots.set(host, snapshot)
      const overrides = queryRainState(window.location.search)
      const rain = snapshot
        ? {
            ...snapshot.rain,
            wind: {
              x: params.has('windX') ? overrides.wind.x : snapshot.rain.wind.x,
              z: params.has('windZ') ? overrides.wind.z : snapshot.rain.wind.z,
            },
          }
        : overrides
      host.dataset.weatherSource = snapshot?.source ?? 'manual'
      host.dataset.weather = snapshot?.weather ?? parseWeather(params.get('weather'))
      host.dataset.rainIntensity = String(rain.intensity)
      const credit = document.querySelector<HTMLElement>('[data-weather-credit]')
      if (credit) credit.hidden = snapshot?.source !== 'live'

      const restart = async () => {
        stop()
        if (lifetime.signal.aborted) return
        const controller = new AbortController()
        preparation = controller
        try {
          const instance = await Engine.create(
            {
              container: host,
              onContextFailure: () => {
                stop()
                onSettled()
              },
              onFirstFrame: () => {
                if (controller.signal.aborted || lifetime.signal.aborted) return
                host.classList.replace('opacity-0', 'opacity-100')
                onSettled()
              },
              reducedMotion: reducedMotion.matches,
              seed,
              weather: snapshot?.weather,
              wind: snapshot?.wind,
              rain,
            },
            controller.signal,
          )
          if (controller.signal.aborted || lifetime.signal.aborted) {
            instance.dispose()
            return
          }
          engine = instance
          resizeObserver = new ResizeObserver(engine.resize)
          resizeObserver.observe(host)
        } catch {
          if (!controller.signal.aborted) {
            stop()
            onSettled()
          }
        }
      }

      // Read the latest preference once the import completes; only one start can be pending.
      reducedMotion.addEventListener('change', restart, { signal: lifetime.signal })
      void restart()
    } catch {
      // Keep the static background if the engine module cannot be loaded.
      if (!lifetime.signal.aborted) {
        lifetime.abort()
        onSettled()
      }
    }
  }

  void start()
  return () => {
    lifetime.abort()
    stop()
  }
}
