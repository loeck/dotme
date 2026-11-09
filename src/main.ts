import { GpuRuntime } from './components/gpu-runtime'
import { initSceneLoader } from './components/scene-loader'
import { startSceneWorld } from './components/scene-world'
import { debugParams, sceneParams } from './scene-params'
import { rapierWasm } from './scene/rapier-wasm'
import type { SceneWeather } from './weather/scene'

let cleanup: (() => void) | undefined
let releasing = Promise.resolve()
/** Kept across bfcache restarts so a restored page reuses the weather of its first load. */
let sceneWeather: Promise<SceneWeather> | undefined

/**
 * Starts the weather request with world preparation, before the GPU device. The module is a
 * dynamic import so the loader entry never carries the weather code (docs/bundle-size.md).
 */
function requestWeather(seed: number, signal: AbortSignal) {
  if (sceneWeather) return sceneWeather
  const { position, weather } = sceneParams(location.search)
  const request = import('./weather/scene').then(({ preloadSceneWeather }) =>
    preloadSceneWeather({ seed, position, ...(weather ? { weather } : {}), signal }),
  )
  sceneWeather = request
  // Only cancellation rejects; forget it so the next start asks again.
  request.catch(() => {
    if (sceneWeather === request) sceneWeather = undefined
  })
  return request
}

function reveal(state: 'ready' | 'failed') {
  document.documentElement.dataset.sceneLoading = state
  document.querySelector('main')?.removeAttribute('aria-busy')
  window.dispatchEvent(new Event('scene-settled'))
}

function start(autoplay = true) {
  if (cleanup) return
  const canvas = document.querySelector<HTMLCanvasElement>('#scene-canvas')
  const host = document.querySelector<HTMLDivElement>('#landscape')
  if (!canvas || !host || document.documentElement.dataset.sceneLoading === 'failed') return
  for (const key of ['loaderRendered', 'sceneRendered', 'backend']) delete canvas.dataset[key]
  const lifetime = new AbortController()
  let runtime: GpuRuntime | undefined
  let pendingCreation: Promise<GpuRuntime> | undefined
  let pendingLoader: ReturnType<typeof initSceneLoader> | undefined
  let pendingLandscape: Promise<void> | undefined
  let stopLoader: (() => void) | undefined
  let stopLandscape: (() => void) | undefined
  const disposeScene = () => {
    for (const dispose of [stopLandscape, stopLoader]) {
      try {
        dispose?.()
      } catch {
        /* Release the renderer even if a scene is already invalid. */
      }
    }
    stopLandscape = undefined
    stopLoader = undefined
    const cancelledCreation = pendingCreation
    pendingCreation = undefined
    const creationReleased =
      cancelledCreation?.then(
        (instance) => instance.dispose(),
        () => undefined,
      ) ?? Promise.resolve()
    const cancelledLandscape = pendingLandscape
    pendingLandscape = undefined
    const cancelledLoader = pendingLoader
    pendingLoader = undefined
    const instance = runtime
    runtime = undefined
    // Three's asynchronous compilation cannot be cancelled. Let it settle and
    // release its scene before destroying the backend it may still be using.
    const released =
      cancelledLoader || cancelledLandscape
        ? Promise.allSettled([cancelledLoader, cancelledLandscape]).then(() => instance?.dispose())
        : (instance?.dispose() ?? Promise.resolve())
    releasing = Promise.all([releasing, released, creationReleased]).then(() => undefined)
    return releasing
  }
  const fail = () => {
    if (lifetime.signal.aborted) return
    reveal('failed')
    lifetime.abort()
    void disposeScene()
  }
  const initialize = async () => {
    const signal = lifetime.signal
    const active = () => !signal.aborted
    // The deadline belongs to the HTML bootstrap (index.html), which dispatches scene-timeout.
    try {
      await releasing
      signal.throwIfAborted()
      // World workers (or the world cache) run while the device and the loader start.
      const world = startSceneWorld(host, signal)
      const weather = requestWeather(world.seed, signal)
      // Rapier's WebAssembly streams and compiles off the main thread alongside the workers.
      void rapierWasm()
      const creation = GpuRuntime.create(canvas, signal, debugParams(location.search).backend)
      pendingCreation = creation
      const instance = await creation
      const ownsCreation = pendingCreation === creation
      if (ownsCreation) pendingCreation = undefined
      if (!active()) {
        // disposeScene owns a creation removed from pendingCreation on abort.
        if (ownsCreation) await instance.dispose()
        return
      }
      runtime = instance
      instance.onFailure = () => {
        if (active()) fail()
      }
      const loading = Promise.resolve()
        .then(() => {
          signal.throwIfAborted()
          return initSceneLoader(instance, signal)
        })
        .then((loader) => {
          if (active()) stopLoader = loader.dispose
          else loader.dispose()
          return loader
        })
      pendingLoader = loading
      const loader = await loading
      if (pendingLoader === loading) pendingLoader = undefined
      if (!active()) return
      // The only import crossing into the landscape occurs after loader presentation.
      const { initLandscape } = await import('./components/landscape')
      signal.throwIfAborted()
      const landscape = Promise.resolve()
        .then(() => {
          signal.throwIfAborted()
          return initLandscape(
            host,
            instance.renderer,
            signal,
            () => {
              if (!active()) return
              loader.dispose()
              stopLoader = undefined
              reveal('ready')
            },
            () => {
              if (active()) fail()
            },
            autoplay,
            world,
            weather,
          )
        })
        .then((teardown) => {
          if (active()) stopLandscape = teardown
          else teardown()
          return undefined
        })
      pendingLandscape = landscape
      await landscape
      if (pendingLandscape === landscape) pendingLandscape = undefined
    } catch (error) {
      if (active()) {
        console.warn('Landscape unavailable:', error)
        fail()
      }
    }
  }
  window.addEventListener('scene-timeout', fail, { signal: lifetime.signal })
  cleanup = () => {
    lifetime.abort()
    void disposeScene()
  }
  void initialize()
}

function stop() {
  cleanup?.()
  cleanup = undefined
}
function restore(event: PageTransitionEvent) {
  if (event.persisted && !cleanup) {
    document.documentElement.dataset.sceneLoading = 'loading'
    window.dispatchEvent(new Event('scene-restart'))
    start(false)
  }
}
start()
window.addEventListener('pagehide', stop)
window.addEventListener('pageshow', restore)
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stop()
    window.removeEventListener('pagehide', stop)
    window.removeEventListener('pageshow', restore)
  })
}
