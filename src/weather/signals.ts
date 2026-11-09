/**
 * A signal aborted as soon as any of `signals` is, with that signal's reason. Uses
 * `AbortSignal.any` (Safari 17.4+, Chrome 116+, Firefox 124+) and a small listener fallback
 * elsewhere.
 */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      return controller.signal
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), {
      once: true,
      signal: controller.signal,
    })
  }
  return controller.signal
}

/** Rejects with the signal's reason when it aborts; otherwise settles as `promise` does. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  let stop: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    stop = () => signal.removeEventListener('abort', abort)
  })
  return Promise.race([promise, aborted]).finally(() => stop?.())
}
