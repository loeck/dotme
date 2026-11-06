import { cleanSceneUrl, sceneParams } from '../scene-params'
import { prepareWorldAsync, storeWorldAsync, WORLD_CACHE } from '../scene/prepare-world'
import type { PreparedWorld } from '../scene/prepare-world'
import { rememberNextSeed, takeNextSeed } from '../scene/world-cache'

/** A delay after the first frame, so the intro and its audio start on idle cores. */
const NEXT_WORLD_DELAY_MS = 4000

export type SceneWorld = Readonly<{
  seed: number
  mobile: boolean
  /** Whether the URL chose the seed; such a world is kept for its reload. */
  requested: boolean
  prepared: Promise<PreparedWorld>
}>

const seeds = new WeakMap<HTMLElement, number>()

const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0] ?? 0

/**
 * Chooses the seed and starts world preparation. The page calls this before creating the GPU
 * device so the workers (or the world cache) overlap device setup and the loader. Restarts of
 * the same host keep its world; a fresh visit takes the world the previous visit prepared.
 */
export function startSceneWorld(host: HTMLElement, signal: AbortSignal): SceneWorld {
  const url = cleanSceneUrl(new URL(location.href))
  if (url.href !== location.href) history.replaceState(history.state, '', url)
  const params = sceneParams(location.search)
  const seed =
    seeds.get(host) ?? params.seed ?? (WORLD_CACHE ? takeNextSeed() : undefined) ?? randomSeed()
  seeds.set(host, seed)
  const mobile = innerWidth < 768
  const prepared = prepareWorldAsync(seed, mobile, signal)
  // Consumers observe failures; a cancelled start must not report an unhandled rejection.
  prepared.catch(() => undefined)
  return { seed, mobile, requested: params.seed !== undefined, prepared }
}

function idle(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let idleHandle = 0
    const timer = window.setTimeout(() => {
      if (typeof requestIdleCallback === 'function')
        idleHandle = requestIdleCallback(() => done(), { timeout: 1000 })
      else done()
    }, delay)
    const abort = () => {
      clearTimeout(timer)
      if (idleHandle) cancelIdleCallback(idleHandle)
      reject(new DOMException('Next world cancelled', 'AbortError'))
    }
    const done = () => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

/**
 * Once the scene runs, prepares the world of the next visit on a background worker and stores
 * it, so a reload skips generation. A seed from the URL is stored as is (its reload shows the
 * same world); otherwise a new seed is drawn, and remembered only once its world is stored.
 */
export function prepareNextWorld(
  world: Omit<SceneWorld, 'prepared'> & { prepared: Promise<Pick<PreparedWorld, 'fromCache'>> },
  signal: AbortSignal,
) {
  if (!WORLD_CACHE || typeof Worker === 'undefined') return
  const run = async () => {
    if (world.requested && (await (await world.prepared).fromCache)) return
    await idle(NEXT_WORLD_DELAY_MS, signal)
    const seed = world.requested ? world.seed : randomSeed()
    await storeWorldAsync(seed, world.mobile, signal)
    if (!world.requested) rememberNextSeed(seed)
  }
  // Storage is an optimisation: quota, private browsing or cancellation leave the next visit
  // to generate its world as before.
  run().catch(() => undefined)
}
