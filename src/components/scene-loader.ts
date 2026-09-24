import { createVoxelLoaderRenderer, VOXEL_LOADER_REST_TIME } from './voxel-loader-renderer'
import type { LoaderMessage } from './voxel-loader.worker'

export function initSceneLoader() {
  const root = document.documentElement
  const overlay = document.querySelector<HTMLDivElement>('.scene-loader')
  const main = document.querySelector('main')
  let canvas = overlay?.querySelector('canvas')
  if (!overlay || !main || !canvas) return { reveal() {}, dispose() {} }

  const lifetime = new AbortController()
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
  let renderer: ReturnType<typeof createVoxelLoaderRenderer> | undefined
  let worker: Worker | undefined
  let frame = 0
  let lastFrame = 0
  let animationStartedAt = 0
  let finished = false
  let removalTimer = 0
  let workerTimer = 0
  root.dataset.sceneLoading = 'loading'
  main.inert = true
  main.setAttribute('aria-busy', 'true')
  canvas.width = Math.round(144 * Math.min(devicePixelRatio || 1, 1.5))
  canvas.height = Math.round(80 * Math.min(devicePixelRatio || 1, 1.5))

  const animated = () => !document.hidden && document.hasFocus() && !reducedMotion.matches
  const post = (message: LoaderMessage, transfer: Transferable[] = []) => {
    // A dedicated Worker has no target origin.
    // eslint-disable-next-line unicorn/require-post-message-target-origin
    worker?.postMessage(message, transfer)
  }
  const tick = (now: number) => {
    if (now - lastFrame >= 1000 / 30) {
      renderer?.render((now - animationStartedAt) / 1000)
      lastFrame = now
    }
    frame = requestAnimationFrame(tick)
  }
  const updateMotion = () => {
    const animate = animated()
    cancelAnimationFrame(frame)
    overlay.dataset.paused = String(!animate)
    post({ type: 'motion', animate })
    if (!renderer) return
    animationStartedAt = performance.now()
    renderer.render(animate ? 0 : VOXEL_LOADER_REST_TIME)
    if (animate) frame = requestAnimationFrame(tick)
  }
  const fallback = () => {
    clearTimeout(workerTimer)
    worker?.terminate()
    worker = undefined
    if (finished || !canvas) return
    // A transferred canvas cannot be reclaimed, including after a worker error.
    const replacement = canvas.cloneNode() as HTMLCanvasElement
    canvas.replaceWith(replacement)
    canvas = replacement
    try {
      renderer = createVoxelLoaderRenderer(canvas)
      overlay.dataset.rendered = 'true'
      updateMotion()
    } catch {
      // The small CSS cubes and loading copy remain available without WebGL.
    }
  }
  try {
    if (typeof Worker === 'undefined' || !canvas.transferControlToOffscreen) fallback()
    else {
      worker = new Worker(new URL('./voxel-loader.worker.ts', import.meta.url), { type: 'module' })
      worker.addEventListener(
        'error',
        (event) => {
          event.preventDefault()
          fallback()
        },
        { signal: lifetime.signal },
      )
      worker.addEventListener(
        'message',
        (event: MessageEvent<string>) => {
          if (event.data === 'unavailable') fallback()
          if (event.data === 'ready') {
            clearTimeout(workerTimer)
            overlay.dataset.rendered = 'true'
          }
        },
        { signal: lifetime.signal },
      )
      const offscreen = canvas.transferControlToOffscreen()
      post({ type: 'start', canvas: offscreen, animate: animated() }, [offscreen])
      workerTimer = window.setTimeout(fallback, 2000)
    }
  } catch {
    fallback()
  }
  reducedMotion.addEventListener('change', updateMotion, { signal: lifetime.signal })
  document.addEventListener('visibilitychange', updateMotion, { signal: lifetime.signal })
  window.addEventListener('blur', updateMotion, { signal: lifetime.signal })
  window.addEventListener('focus', updateMotion, { signal: lifetime.signal })
  overlay.dataset.paused = String(!animated())

  const stopRendering = () => {
    lifetime.abort()
    clearTimeout(workerTimer)
    cancelAnimationFrame(frame)
    renderer?.dispose()
    renderer = undefined
    if (worker) {
      const retiringWorker = worker
      const deadline = window.setTimeout(() => retiringWorker.terminate(), 250)
      retiringWorker.addEventListener(
        'message',
        () => {
          clearTimeout(deadline)
          retiringWorker.terminate()
        },
        { once: true },
      )
      post({ type: 'stop' })
      worker = undefined
    }
    // Restore an untransferred canvas for bfcache and hot reload.
    if (canvas) canvas.replaceWith(canvas.cloneNode())
    delete overlay.dataset.rendered
    delete overlay.dataset.paused
  }
  const reveal = () => {
    if (finished) return
    finished = true
    clearTimeout(failsafe)
    main.inert = false
    main.removeAttribute('aria-busy')
    root.dataset.sceneLoading = 'revealing'
    removalTimer = window.setTimeout(
      () => {
        stopRendering()
        delete root.dataset.sceneLoading
      },
      reducedMotion.matches ? 0 : 600,
    )
  }
  // A stalled network or graphics driver must not leave the profile inaccessible.
  const failsafe = window.setTimeout(reveal, 20_000)
  return {
    reveal,
    dispose() {
      finished = true
      clearTimeout(failsafe)
      clearTimeout(removalTimer)
      stopRendering()
      main.inert = false
      main.removeAttribute('aria-busy')
      delete root.dataset.sceneLoading
    },
  }
}
