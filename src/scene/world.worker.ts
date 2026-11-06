import { readCachedPart, storeWorld } from './world-cache'
import { prepareAllWorldParts, prepareWorldPart, worldTransfers } from './world-data'
import type { WorldRequest } from './world-data'

/**
 * The content-hashed URL of this bundle in production: any change to the generator renames it,
 * which retires every stored world.
 */
const version = new URL(import.meta.url).pathname

async function handle({ seed, mobile, part, cache }: WorldRequest) {
  if (part === 'store') {
    await storeWorld(version, seed, mobile, prepareAllWorldParts(seed, mobile))
    self.postMessage({ part: 'stored' }, { transfer: [] })
    return
  }
  const cached = cache ? await readCachedPart(version, seed, mobile, part) : undefined
  // Same shape as the generator's message: written by this very bundle for this seed.
  const message: unknown =
    cached === undefined
      ? prepareWorldPart(seed, mobile, part)
      : { part, data: cached, cached: true }
  self.postMessage(message, { transfer: worldTransfers(message) })
}

self.addEventListener('message', (event: MessageEvent<WorldRequest>) => {
  handle(event.data).catch((error: unknown) => {
    // Surface as a worker error so the page fails or skips this preparation like any other.
    setTimeout(() => {
      throw error
    })
  })
})
