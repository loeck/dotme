import type {
  PreparedWorld,
  SurfacePart,
  TerrainPart,
  VegetationPart,
  WorldPartMessage,
  WorldRequest,
} from './world-data'
export type { PreparedWorld } from './world-data'

const cancelled = () => new DOMException('World preparation cancelled', 'AbortError')

/** One worker per part; kept here so the loader entry does not import the generator. */
const WORLD_PARTS = ['terrain', 'surfaces', 'vegetation'] as const

/**
 * Production builds keep prepared worlds in the origin private file system (see
 * `world-cache.ts`). Development bundles have no content hash to version the generator with, so
 * they always generate.
 */
export const WORLD_CACHE = import.meta.env.PROD

const spawnWorker = () =>
  new Worker(new URL('./world.worker.ts', import.meta.url), { type: 'module' })

function post(worker: Worker, request: WorldRequest) {
  // A dedicated Worker has no target origin.
  // eslint-disable-next-line unicorn/require-post-message-target-origin
  worker.postMessage(request)
}

/**
 * Prepares the world on three workers, one per part: the terrain mesh and boulders, the lake
 * surfaces with cloud noise and collision data, and the forest. Each worker first looks the
 * part up in the world cache. The world resolves with terrain and surfaces; the forest follows
 * as `vegetation`, so physics and scene construction start without it. Every part arrives as
 * transferred buffers; the page only combines them. `fromCache` tells whether all three parts
 * came from the cache.
 */
export function prepareWorldAsync(
  seed: number,
  mobile: boolean,
  signal: AbortSignal,
  cache = WORLD_CACHE,
): Promise<PreparedWorld> {
  if (signal.aborted) return Promise.reject(cancelled())
  performance.clearMarks('worldprep-start')
  performance.clearMarks('worldprep-ready')
  performance.clearMarks('vegetation-ready')
  performance.clearMarks('worldprep-cached')
  performance.mark('worldprep-start')
  // Synchronous fallback is limited to platforms without Worker support.
  if (typeof Worker === 'undefined')
    return import('./world-data').then(({ prepareWorld }) => {
      signal.throwIfAborted()
      const world = prepareWorld(seed, mobile)
      performance.mark('worldprep-ready')
      return world
    })
  // The executor runs synchronously, so both settlers exist before any worker message.
  const settleForest: {
    resolve?: (data: VegetationPart) => void
    reject?: (error: Error) => void
  } = {}
  const vegetation = new Promise<VegetationPart>((resolve, reject) => {
    settleForest.resolve = resolve
    settleForest.reject = reject
  })
  // The engine handles its own subscription; a world that never gets that far must not
  // report an unhandled rejection.
  vegetation.catch(() => undefined)
  // Parts arrive in any order: the answer is known at the first generated part or the last hit.
  let hits = 0
  let settleCache: ((cached: boolean) => void) | undefined
  const fromCache = new Promise<boolean>((resolve) => {
    settleCache = resolve
  })
  return new Promise((resolve, reject) => {
    const workers: Worker[] = []
    let terrain: TerrainPart | undefined
    let surfaces: SurfacePart | undefined
    let world = false,
      forest = false
    const cleanup = () => {
      for (const worker of workers) worker.terminate()
      signal.removeEventListener('abort', abort)
    }
    const fail = (error: Error) => {
      settleCache?.(false)
      if (world && forest) return
      cleanup()
      if (!forest) {
        forest = true
        settleForest.reject?.(error)
      }
      if (!world) {
        world = true
        reject(error)
      }
    }
    const abort = () => fail(cancelled())
    signal.addEventListener('abort', abort, { once: true })
    for (const part of WORLD_PARTS) {
      const worker = spawnWorker()
      workers.push(worker)
      worker.addEventListener('message', (event: MessageEvent<WorldPartMessage>) => {
        const message = event.data
        // Each worker delivers once; release its memory before the others finish.
        worker.terminate()
        if (!message.cached) settleCache?.(false)
        else if (++hits === WORLD_PARTS.length) {
          performance.mark('worldprep-cached')
          settleCache?.(true)
        }
        if (message.part === 'vegetation') {
          if (forest) return
          forest = true
          if (world) cleanup()
          performance.mark('vegetation-ready')
          settleForest.resolve?.(message.data)
          return
        }
        if (world) return
        if (message.part === 'terrain') terrain = message.data
        else surfaces = message.data
        if (!terrain || !surfaces) return
        world = true
        if (forest) cleanup()
        performance.mark('worldprep-ready')
        resolve({ ...terrain, ...surfaces, vegetation, fromCache })
      })
      worker.addEventListener('error', (event) => {
        fail(new Error(event.message || 'World preparation failed'))
      })
      worker.addEventListener('messageerror', () => {
        fail(new Error('Invalid prepared world'))
      })
      post(worker, { seed, mobile, part, cache })
    }
  })
}

/**
 * Prepares every part of `seed` on one background worker and stores it for a later visit.
 * Resolves once the world is stored; rejects if storage or generation fails or `signal` aborts.
 */
export function storeWorldAsync(seed: number, mobile: boolean, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelled())
      return
    }
    const worker = spawnWorker()
    const finish = (error?: Error) => {
      worker.terminate()
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve()
    }
    const abort = () => finish(cancelled())
    signal.addEventListener('abort', abort, { once: true })
    worker.addEventListener('message', () => finish())
    worker.addEventListener('error', (event) => {
      // The worker rethrows storage failures; keep them out of the page's error log.
      event.preventDefault()
      finish(new Error(event.message || 'World storage failed'))
    })
    post(worker, { seed, mobile, part: 'store', cache: true })
  })
}
