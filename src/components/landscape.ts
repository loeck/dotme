import type { VoxelLandscapeEngine } from '../scene/VoxelLandscapeEngine'

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

export function initLandscape(host: HTMLDivElement): () => void {
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
      const [{ VoxelLandscapeEngine: Engine }, { queryRainState }] = await Promise.all([
        import('../scene/VoxelLandscapeEngine'),
        import('../scene/rain-simulation'),
      ])
      if (lifetime.signal.aborted) return

      const restart = async () => {
        stop()
        if (lifetime.signal.aborted) return
        const controller = new AbortController()
        preparation = controller
        try {
          const instance = await Engine.create(
            {
              container: host,
              onContextFailure: stop,
              onFirstFrame: () => host.classList.replace('opacity-0', 'opacity-100'),
              reducedMotion: reducedMotion.matches,
              seed,
              rain: queryRainState(window.location.search),
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
          if (!controller.signal.aborted) stop()
        }
      }

      // Read the latest preference once the import completes; only one start can be pending.
      reducedMotion.addEventListener('change', restart, { signal: lifetime.signal })
      void restart()
    } catch {
      // Keep the static background if the engine module cannot be loaded.
    }
  }

  void start()
  return () => {
    lifetime.abort()
    stop()
  }
}
