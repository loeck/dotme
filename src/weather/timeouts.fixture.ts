import { vi } from 'vitest'

/**
 * Fake timers do not drive `AbortSignal.timeout`: route it through `setTimeout`, so deadlines
 * fire when a test advances the fake clock. Native `AbortSignal.timeout` holds no timer that
 * needs releasing, so tests should clear the fake ones afterwards.
 */
export function fakeAbortTimeouts() {
  return vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
    const controller = new AbortController()
    setTimeout(
      () => controller.abort(new DOMException('signal timed out', 'TimeoutError')),
      milliseconds,
    )
    return controller.signal
  })
}

/** A small in-memory `Storage` for the weather cache in Node. */
export function memoryStorage() {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key: string) => items.get(key) ?? null,
    key: (index: number) => [...items.keys()][index] ?? null,
    removeItem: (key: string) => void items.delete(key),
    setItem: (key: string, value: string) => void items.set(key, value),
  }
}
