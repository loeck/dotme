import type { WebGPURenderer } from 'three/webgpu'

import { cleanSceneUrl, sceneParams } from '../scene-params'
import { prepareWorldAsync } from '../scene/prepare-world'
import { VoxelLandscapeEngine } from '../scene/VoxelLandscapeEngine'
import { preloadSceneWeather } from '../weather/scene'
import type { SceneWeather } from '../weather/scene'
import { initAmbientSound } from './ambient-sound'
import { initSceneCursor } from './scene-cursor'
import { initSceneInfo } from './scene-info'

const seeds = new WeakMap<HTMLDivElement, number>()
const weatherSnapshots = new WeakMap<HTMLDivElement, SceneWeather>()

export async function initLandscape(
  host: HTMLDivElement,
  renderer: WebGPURenderer,
  signal: AbortSignal,
  onFirstFrame: () => void,
  onFailure: () => void,
  autoplay: boolean,
): Promise<() => void> {
  const url = cleanSceneUrl(new URL(location.href))
  if (url.href !== location.href) history.replaceState(history.state, '', url)
  const params = sceneParams(location.search)
  const seed = seeds.get(host) ?? params.seed ?? crypto.getRandomValues(new Uint32Array(1))[0] ?? 0
  seeds.set(host, seed)
  const [prepared, snapshot] = await Promise.all([
    prepareWorldAsync(seed, innerWidth < 768, signal),
    weatherSnapshots.get(host) ?? preloadSceneWeather({ seed, position: params.position, signal }),
  ])
  signal.throwIfAborted()
  weatherSnapshots.set(host, snapshot)
  host.dataset.weatherSource = snapshot.source
  host.dataset.weather = snapshot.weather
  host.dataset.rainIntensity = String(snapshot.rain.intensity)
  const credit = document.querySelector<HTMLElement>('[data-weather-credit]')
  if (credit) credit.hidden = snapshot.source !== 'live'
  const sound = initAmbientSound(false)
  const cursor = document.querySelector<HTMLDivElement>('.scene-cursor')
  const stopCursor = cursor ? initSceneCursor(cursor) : undefined
  const stopInfo = initSceneInfo()
  let engine: VoxelLandscapeEngine | undefined
  let observer: ResizeObserver | undefined
  let audioFrame = 0
  let audioTimer = 0
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    cancelAnimationFrame(audioFrame)
    clearTimeout(audioTimer)
    observer?.disconnect()
    engine?.dispose()
    stopInfo?.()
    stopCursor?.()
    sound.dispose()
    signal.removeEventListener('abort', dispose)
  }
  signal.addEventListener('abort', dispose, { once: true })
  try {
    const motion = matchMedia('(prefers-reduced-motion: reduce)')
    engine = await VoxelLandscapeEngine.create(
      {
        container: host,
        renderer,
        prepared,
        seed,
        onContextFailure: onFailure,
        onFirstFrame: () => {
          onFirstFrame()
          // Let the completed scene paint before opening the browser's audio device.
          if (autoplay)
            audioFrame = requestAnimationFrame(() => {
              audioTimer = window.setTimeout(() => {
                if (!disposed) sound.startAutoplay()
              }, 0)
            })
        },
        onEnvironment: (state) => sound.setEnvironment(state),
        reducedMotion: motion.matches,
        weather: snapshot.weather,
        wind: snapshot.wind,
        rain: snapshot.rain,
        solar: snapshot.solar,
        nowSeconds: snapshot.nowSeconds,
      },
      signal,
    )
    signal.throwIfAborted()
    engine.setReducedMotion(motion.matches)
    motion.addEventListener('change', () => engine?.setReducedMotion(motion.matches), { signal })
    observer = new ResizeObserver(engine.resize)
    observer.observe(host)
    return dispose
  } catch (error) {
    dispose()
    throw error
  }
}
