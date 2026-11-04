import { prepareWorld, WORLD_PARTS } from './world-data'
import type {
  PreparedWorld,
  SurfacePart,
  TerrainPart,
  VegetationPart,
  WorldPartMessage,
} from './world-data'
export type { PreparedWorld } from './world-data'

const cancelled = () => new DOMException('World preparation cancelled', 'AbortError')

/**
 * Prepares the world on two workers: one meshes terrain while the other builds
 * the lake surfaces, cloud noise and collision boxes from the same seed, then
 * grows the forest. The world resolves with terrain and surfaces; the forest
 * follows as `vegetation`, so physics and scene construction start without it. Every part
 * arrives as transferred buffers; the page only combines them.
 */
export function prepareWorldAsync(
  seed: number,
  mobile: boolean,
  signal: AbortSignal,
): Promise<PreparedWorld> {
  if (signal.aborted) return Promise.reject(cancelled())
  performance.clearMarks('worldprep-start')
  performance.clearMarks('worldprep-ready')
  performance.clearMarks('vegetation-ready')
  performance.mark('worldprep-start')
  // Synchronous fallback is limited to platforms without Worker support.
  if (typeof Worker === 'undefined') {
    const world = prepareWorld(seed, mobile)
    performance.mark('worldprep-ready')
    return Promise.resolve(world)
  }
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
      const worker = new Worker(new URL('./world.worker.ts', import.meta.url), { type: 'module' })
      workers.push(worker)
      worker.addEventListener('message', (event: MessageEvent<WorldPartMessage>) => {
        const message = event.data
        if (message.part === 'vegetation') {
          if (forest) return
          forest = true
          // The forest can finish before the terrain; stop only its own worker.
          worker.terminate()
          if (world) cleanup()
          performance.mark('vegetation-ready')
          settleForest.resolve?.(message.data)
          return
        }
        if (world) return
        // The terrain worker delivers once; release its memory before the other finishes.
        if (message.part === 'terrain') {
          worker.terminate()
          terrain = message.data
        } else surfaces = message.data
        if (!terrain || !surfaces) return
        world = true
        if (forest) cleanup()
        performance.mark('worldprep-ready')
        resolve({ ...terrain, ...surfaces, vegetation })
      })
      worker.addEventListener('error', (event) => {
        fail(new Error(event.message || 'World preparation failed'))
      })
      worker.addEventListener('messageerror', () => {
        fail(new Error('Invalid prepared world'))
      })
      // A dedicated Worker has no target origin.
      // eslint-disable-next-line unicorn/require-post-message-target-origin
      worker.postMessage({ seed, mobile, part })
    }
  })
}
