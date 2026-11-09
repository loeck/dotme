import { cleanSceneUrl, sceneParams } from '../scene-params'
import { isLowPowerDevice } from '../scene/device-profile'
import { prepareWorldAsync, storeWorldAsync, WORLD_CACHE } from '../scene/prepare-world'
import type { PreparedWorld } from '../scene/prepare-world'
import { preloadTerrainImages } from '../scene/terrain-images'
import {
  expectedWorldBytes,
  rememberNextSeed,
  storedWorldBytes,
  takeNextSeed,
} from '../scene/world-cache'

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
 * Chooses the seed and starts world preparation and the terrain scans' download. The page calls
 * this before creating the GPU device so the workers (or the world cache) and the image decodes
 * overlap device setup and the loader. Restarts of the same host keep its world; a fresh visit
 * takes the world the previous visit prepared.
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
  preloadTerrainImages(isLowPowerDevice())
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

/** What the next-world guards read; `environment()` reads the browser's own. */
export type NextWorldEnvironment = Readonly<{
  saveData: boolean
  lowPower: boolean
  hidden: boolean
  /** Origin storage usage and quota, when the browser reports them. */
  estimate: () => Promise<Readonly<{ usage?: number; quota?: number }> | undefined>
  /** Bytes of the stored world the next one replaces (already counted in the usage). */
  stored?: (mobile: boolean) => Promise<number>
}>

function environment(): NextWorldEnvironment {
  const connection = 'connection' in navigator ? navigator.connection : undefined
  const saveData =
    typeof connection === 'object' &&
    connection !== null &&
    'saveData' in connection &&
    connection.saveData === true
  return {
    saveData,
    lowPower: isLowPowerDevice(),
    hidden: typeof document !== 'undefined' && document.hidden,
    estimate: async () =>
      typeof navigator.storage?.estimate === 'function' ? navigator.storage.estimate() : undefined,
    stored: storedWorldBytes,
  }
}

/** The share of the origin's quota a stored world may bring usage up to. */
const QUOTA_SHARE = 0.5

/**
 * Whether preparing and storing the next world is worth its cost here: not when the visitor
 * asked to save data, on a low-power device (the background generation competes with the
 * scene for a phone's cores and battery), in a hidden tab, or when the world would take usage
 * past half of the quota. An unknown estimate does not block: the write fails on its own.
 */
export async function nextWorldAllowed(
  mobile: boolean,
  env: NextWorldEnvironment = environment(),
): Promise<boolean> {
  if (env.saveData || env.lowPower || env.hidden) return false
  const estimate = await env.estimate().catch(() => undefined)
  const { usage, quota } = estimate ?? {}
  if (typeof usage !== 'number' || typeof quota !== 'number' || quota <= 0) return true
  // Storing the next world replaces this profile's current one: do not count it twice.
  const replaced = Math.min(usage, Math.max(0, (await env.stored?.(mobile).catch(() => 0)) ?? 0))
  return usage - replaced + expectedWorldBytes(mobile) <= quota * QUOTA_SHARE
}

/**
 * Once the scene runs, prepares the world of the next visit on a background worker and stores
 * it, so a reload skips generation. A seed from the URL is stored as is (its reload shows the
 * same world); otherwise a new seed is drawn, and remembered only once its world is stored.
 */
export function prepareNextWorld(
  world: Omit<SceneWorld, 'prepared'> & { prepared: Promise<Pick<PreparedWorld, 'fromCache'>> },
  signal: AbortSignal,
  env?: () => NextWorldEnvironment,
) {
  if (!WORLD_CACHE || typeof Worker === 'undefined') return
  const run = async () => {
    if (world.requested && (await (await world.prepared).fromCache)) return
    await idle(NEXT_WORLD_DELAY_MS, signal)
    // Checked once idle: the tab may have been hidden and storage may have filled meanwhile.
    if (!(await nextWorldAllowed(world.mobile, env?.()))) return
    signal.throwIfAborted()
    const seed = world.requested ? world.seed : randomSeed()
    await storeWorldAsync(seed, world.mobile, signal)
    if (!world.requested) rememberNextSeed(seed)
  }
  // Storage is an optimisation: quota, private browsing or cancellation leave the next visit
  // to generate its world as before.
  run().catch(() => undefined)
}
