/** Three's rAF fallback spends a full frame on every tiny compiler stage in Safari. */
export function installCompilationScheduler(host: object = globalThis): () => void {
  const existing: unknown = 'scheduler' in host ? host.scheduler : undefined
  const scheduler = existing !== null && typeof existing === 'object' ? existing : {}
  if ('yield' in scheduler && typeof scheduler.yield === 'function') return () => {}

  const hostDescriptor = Object.getOwnPropertyDescriptor(host, 'scheduler')
  const yieldDescriptor = Object.getOwnPropertyDescriptor(scheduler, 'yield')
  const channel = new MessageChannel()
  const pending = new Set<() => void>()
  let frame: number | undefined
  let lastFrame = performance.now()
  let disposed = false
  const flush = () => {
    const callbacks = [...pending]
    pending.clear()
    for (const resolve of callbacks) resolve()
  }
  const resumeTask = () => {
    if (disposed || pending.size === 0) return
    // Tasks keep input responsive; the frame budget also gives the shared loader
    // a presentation opportunity without charging every shader node a whole frame.
    if (!document.hidden && performance.now() - lastFrame >= 8) {
      frame ??= requestAnimationFrame(() => {
        frame = undefined
        lastFrame = performance.now()
        flush()
      })
    } else flush()
  }
  channel.port1.addEventListener('message', resumeTask)
  channel.port1.start()
  const resumeHidden = () => {
    if (!document.hidden) return
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    lastFrame = performance.now()
    flush()
  }
  document.addEventListener('visibilitychange', resumeHidden)
  const yieldTask = () =>
    new Promise<void>((resolve) => {
      if (disposed) {
        resolve()
        return
      }
      pending.add(resolve)
      channel.port2.postMessage(null)
    })
  Object.defineProperty(scheduler, 'yield', {
    configurable: true,
    writable: true,
    value: yieldTask,
  })
  if (scheduler !== existing)
    Object.defineProperty(host, 'scheduler', {
      configurable: true,
      writable: true,
      value: scheduler,
    })

  return () => {
    if (disposed) return
    disposed = true
    if (frame !== undefined) cancelAnimationFrame(frame)
    document.removeEventListener('visibilitychange', resumeHidden)
    channel.port1.removeEventListener('message', resumeTask)
    channel.port1.close()
    channel.port2.close()
    flush()
    if (yieldDescriptor) Object.defineProperty(scheduler, 'yield', yieldDescriptor)
    else Reflect.deleteProperty(scheduler, 'yield')
    if (scheduler !== existing) {
      if (hostDescriptor) Object.defineProperty(host, 'scheduler', hostDescriptor)
      else Reflect.deleteProperty(host, 'scheduler')
    }
  }
}
