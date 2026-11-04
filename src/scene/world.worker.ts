import { prepareWorldParts, worldTransfers } from './world-data'
import type { WorldPart } from './world-data'

self.addEventListener(
  'message',
  (event: MessageEvent<{ seed: number; mobile: boolean; part: WorldPart }>) => {
    for (const message of prepareWorldParts(event.data.seed, event.data.mobile, event.data.part))
      self.postMessage(message, { transfer: worldTransfers(message) })
  },
)
