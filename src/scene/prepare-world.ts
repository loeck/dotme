import { prepareWorld } from './world-data'
import type { PreparedWorld } from './world-data'
export type { PreparedWorld } from './world-data'

export function prepareWorldAsync(
  seed: number,
  mobile: boolean,
  signal: AbortSignal,
): Promise<PreparedWorld> {
  if (signal.aborted)
    return Promise.reject(new DOMException('World preparation cancelled', 'AbortError'))
  // Synchronous fallback is limited to platforms without Worker support.
  if (typeof Worker === 'undefined') return Promise.resolve(prepareWorld(seed, mobile))
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./world.worker.ts', import.meta.url), { type: 'module' })
    const cleanup = () => {
      worker.terminate()
      signal.removeEventListener('abort', abort)
    }
    const abort = () => {
      cleanup()
      reject(new DOMException('World preparation cancelled', 'AbortError'))
    }
    signal.addEventListener('abort', abort, { once: true })
    worker.addEventListener('message', (event: MessageEvent<PreparedWorld>) => {
      cleanup()
      resolve(event.data)
    })
    worker.addEventListener('error', (event) => {
      cleanup()
      reject(new Error(event.message || 'World preparation failed'))
    })
    worker.addEventListener('messageerror', () => {
      cleanup()
      reject(new Error('Invalid prepared world'))
    })
    // A dedicated Worker has no target origin.
    // eslint-disable-next-line unicorn/require-post-message-target-origin
    worker.postMessage({ seed, mobile })
  })
}
