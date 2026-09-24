/** Controllable requests avoid timing-dependent fixed waits. */
export function deferred() {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: () => {
      if (!resolvePromise) throw new Error('Promise executor did not initialize')
      resolvePromise()
    },
  }
}
