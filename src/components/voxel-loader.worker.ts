import { createVoxelLoaderRenderer, VOXEL_LOADER_REST_TIME } from './voxel-loader-renderer'

// Dedicated worker messages have no target origin.
/* eslint-disable unicorn/require-post-message-target-origin */

export type LoaderMessage =
  | { type: 'start'; canvas: OffscreenCanvas; animate: boolean }
  | { type: 'motion'; animate: boolean }
  | { type: 'stop' }

let renderer: ReturnType<typeof createVoxelLoaderRenderer> | undefined
let timer: ReturnType<typeof setInterval> | undefined

function motion(animate: boolean) {
  clearInterval(timer)
  timer = undefined
  renderer?.render(animate ? 0 : VOXEL_LOADER_REST_TIME)
  const startedAt = performance.now()
  if (animate)
    timer = setInterval(() => renderer?.render((performance.now() - startedAt) / 1000), 1000 / 30)
}

self.addEventListener('message', (event: MessageEvent<LoaderMessage>) => {
  try {
    const message = event.data
    if (message.type === 'start') {
      renderer = createVoxelLoaderRenderer(message.canvas)
      motion(message.animate)
      self.postMessage('ready')
    } else if (message.type === 'motion') {
      motion(message.animate)
    } else {
      clearInterval(timer)
      renderer?.dispose()
      renderer = undefined
      self.postMessage('stopped')
    }
  } catch {
    clearInterval(timer)
    renderer?.dispose()
    renderer = undefined
    self.postMessage('unavailable')
  }
})
