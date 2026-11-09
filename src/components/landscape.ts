import type { WebGPURenderer } from 'three/webgpu'

import { reducedMotionQuery } from '../env'
import { debugParams, sceneParams } from '../scene-params'
import { LandscapeEngine } from '../scene/landscape-engine'
import { loadPhysics } from '../scene/physics-world'
import type { SceneWeather } from '../weather/scene'
import { initAmbientSound } from './ambient-sound'
import { initSceneCursor } from './scene-cursor'
import { initSceneInfo } from './scene-info'
import { prepareNextWorld } from './scene-world'
import type { SceneWorld } from './scene-world'
import { shockwaveHaptics, stoneHaptics } from './stone-haptics'

export async function initLandscape(
  host: HTMLDivElement,
  renderer: WebGPURenderer,
  signal: AbortSignal,
  onFirstFrame: () => void,
  onFailure: () => void,
  autoplay: boolean,
  world: SceneWorld,
  /** Requested by the page alongside world preparation, before this module loads. */
  weather: Promise<SceneWeather>,
): Promise<() => void> {
  const { seed } = world
  // The engine reuses this cached promise; starting it here overlaps the
  // deferred physics download and instantiation with world preparation.
  void loadPhysics()
  const [prepared, snapshot] = await Promise.all([world.prepared, weather])
  signal.throwIfAborted()
  const credit = document.querySelector<HTMLElement>('[data-weather-credit]')
  const describe = (current: SceneWeather) => {
    host.dataset.weatherSource = current.source
    host.dataset.weather = current.weather
    host.dataset.rainIntensity = String(current.rain.intensity)
    if (credit) credit.hidden = current.source !== 'live'
  }
  describe(snapshot)
  const sound = initAmbientSound(false)
  sound.setWeather(snapshot)
  const cursor = document.querySelector<HTMLDivElement>('.scene-cursor')
  const stopCursor = cursor ? initSceneCursor(cursor) : undefined
  const stopInfo = initSceneInfo()
  let engine: LandscapeEngine | undefined
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
    const motion = reducedMotionQuery()
    engine = await LandscapeEngine.create(
      {
        container: host,
        renderer,
        prepared,
        seed,
        onContextFailure: onFailure,
        onFirstFrame: () => {
          onFirstFrame()
          prepareNextWorld(world, signal)
          // Let the completed scene paint before opening the browser's audio device.
          if (autoplay)
            audioFrame = requestAnimationFrame(() => {
              audioTimer = window.setTimeout(() => {
                if (!disposed) sound.startAutoplay()
              }, 0)
            })
        },
        onEnvironment: (state) => sound.setEnvironment(state),
        onWaterSound: (event) => sound.waterSound(event),
        onStoneTouchdown: (event) => {
          stoneHaptics(event)
          sound.skipNote(event)
        },
        onShockwave: (event) => {
          shockwaveHaptics(event)
          // The wave rings the root of the current mood an octave down, as a sinking stone does.
          sound.skipNote({
            index: 0,
            sinking: true,
            intensity: event.intensity * (0.6 + 0.4 * event.charge),
            pan: event.pan,
          })
        },
        onThunder: (event) => sound.thunder(event),
        storm: snapshot.storm ?? false,
        reducedMotion: motion.matches,
        weather: snapshot.weather,
        wind: snapshot.wind,
        rain: snapshot.rain,
        solar: snapshot.solar,
        nowSeconds: snapshot.nowSeconds,
        climate: { temperature: snapshot.temperature, fog: snapshot.fog, snow: snapshot.snow },
        // Forced weather never changes; live and fallback weather are watched below.
        weatherMayChange: snapshot.source !== 'override',
      },
      signal,
    )
    signal.throwIfAborted()
    // Keep a long visit current: each new 15-minute slot eases the scene and the sound into it.
    if (snapshot.source !== 'override') {
      // A forced `?weather=` always yields an 'override' snapshot, so only the position matters.
      const { position } = sceneParams(location.search)
      const refresh = (next: SceneWeather) => {
        if (disposed) return
        describe(next)
        sound.setWeather(next)
        engine?.setWeather(next)
      }
      void import('../weather/watch')
        .then(({ watchSceneWeather }) =>
          watchSceneWeather({ position, current: snapshot }, refresh, signal),
        )
        // A failed chunk only loses later refreshes: the scene keeps its preloaded weather.
        .catch(() => {})
    }
    engine.setReducedMotion(motion.matches)
    motion.addEventListener('change', () => engine?.setReducedMotion(motion.matches), { signal })
    observer = new ResizeObserver(engine.resize)
    observer.observe(host)
    const { perf } = debugParams(location.search)
    if (perf)
      void import('./perf-overlay').then(({ initPerfOverlay }) => {
        if (!signal.aborted) initPerfOverlay(renderer, signal, perf)
        return undefined
      })
    return dispose
  } catch (error) {
    dispose()
    throw error
  }
}
