import type { AmbientEnvironment } from '../audio/environment'
import { sceneParams } from '../scene-params'
import type { VoxelLandscapeEngine } from '../scene/VoxelLandscapeEngine'
import { preloadSceneWeather } from '../weather/scene'
import type { SceneWeather } from '../weather/scene'

function randomSeed(): number {
  return globalThis.crypto?.getRandomValues
    ? globalThis.crypto.getRandomValues(new Uint32Array(1))[0]!
    : Math.floor(Math.random() * 0x1_0000_0000)
}

// Keep a page's composition when its DOM is restored from the back/forward cache.
const seeds = new WeakMap<HTMLDivElement, number>()
const weatherSnapshots = new WeakMap<HTMLDivElement, SceneWeather>()

export function initLandscape(
  host: HTMLDivElement,
  onSettled: () => void = () => {},
  sound?: { setEnvironment: (state: AmbientEnvironment) => void; fail: () => void },
): () => void {
  const lifetime = new AbortController()
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const params = sceneParams(window.location.search)
  const seed = seeds.get(host) ?? params.seed ?? randomSeed()
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
      const [{ VoxelLandscapeEngine: Engine }, snapshot] = await Promise.all([
        import('../scene/VoxelLandscapeEngine'),
        weatherSnapshots.get(host) ??
          preloadSceneWeather({ seed, position: params.position, signal: lifetime.signal }),
      ])
      if (lifetime.signal.aborted) return
      weatherSnapshots.set(host, snapshot)
      const rain = snapshot.rain
      host.dataset.weatherSource = snapshot.source
      host.dataset.weather = snapshot.weather
      host.dataset.rainIntensity = String(rain.intensity)
      const credit = document.querySelector<HTMLElement>('[data-weather-credit]')
      if (credit) credit.hidden = snapshot.source !== 'live'

      const restart = async () => {
        stop()
        if (lifetime.signal.aborted) return
        const controller = new AbortController()
        preparation = controller
        try {
          const instance = await Engine.create(
            {
              container: host,
              onEnvironment: sound?.setEnvironment,
              onContextFailure: () => {
                sound?.fail()
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
              weather: snapshot.weather,
              wind: snapshot.wind,
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
            sound?.fail()
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
        sound?.fail()
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
