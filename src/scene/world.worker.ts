import { prepareWorld, worldTransfers } from './world-data'

self.addEventListener('message', (event: MessageEvent<{ seed: number; mobile: boolean }>) => {
  const prepared = prepareWorld(event.data.seed, event.data.mobile)
  self.postMessage(prepared, { transfer: worldTransfers(prepared) })
})
