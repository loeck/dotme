import { prepareWorld, WORLD_PARTS } from './world-data'
import type { PreparedWorld, SurfacePart, TerrainPart, WorldPartMessage } from './world-data'
export type { PreparedWorld } from './world-data'

const cancelled = () => new DOMException('World preparation cancelled', 'AbortError')

/**
 * Prepares the world on two workers: one meshes terrain while the other builds
 * the lake surfaces, cloud noise and collision boxes from the same seed. Both
 * halves arrive as transferred buffers; the page only combines them.
 */
export function prepareWorldAsync(
  seed: number,
  mobile: boolean,
  signal: AbortSignal,
): Promise<PreparedWorld> {
  if (signal.aborted) return Promise.reject(cancelled())
  performance.clearMarks('worldprep-start')
  performance.clearMarks('worldprep-ready')
  performance.mark('worldprep-start')
  // Synchronous fallback is limited to platforms without Worker support.
  if (typeof Worker === 'undefined') {
    const world = prepareWorld(seed, mobile)
    performance.mark('worldprep-ready')
    return Promise.resolve(world)
  }
  return new Promise((resolve, reject) => {
    const workers: Worker[] = []
    let terrain: TerrainPart | undefined
    let surfaces: SurfacePart | undefined
    let settled = false
    const cleanup = () => {
      settled = true
      for (const worker of workers) worker.terminate()
      signal.removeEventListener('abort', abort)
    }
    const fail = (error: Error) => {
      if (settled) return
      cleanup()
      reject(error)
    }
    const abort = () => fail(cancelled())
    signal.addEventListener('abort', abort, { once: true })
    for (const part of WORLD_PARTS) {
      const worker = new Worker(new URL('./world.worker.ts', import.meta.url), { type: 'module' })
      workers.push(worker)
      worker.addEventListener('message', (event: MessageEvent<WorldPartMessage>) => {
        if (settled) return
        // Each worker delivers once; release its memory before the other finishes.
        worker.terminate()
        const message = event.data
        if (message.part === 'terrain') terrain = message.data
        else surfaces = message.data
        if (!terrain || !surfaces) return
        cleanup()
        performance.mark('worldprep-ready')
        resolve({ ...terrain, ...surfaces })
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
