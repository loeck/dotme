// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { required } from './invariant'
const fake = vi.hoisted(() => {
  const loader = vi.fn<() => Promise<{ dispose(): void }>>()
  const landscape =
    vi.fn<
      (
        host: HTMLElement,
        renderer: object,
        signal: AbortSignal,
        ready: () => void,
        failed: () => void,
        autoplay: boolean,
      ) => Promise<() => void>
    >()
  const created: Runtime[] = []
  class Runtime {
    readonly renderer = {}
    readonly canvas: HTMLCanvasElement
    readonly signal: AbortSignal
    onFailure: (() => void) | undefined
    dispose = vi.fn<() => Promise<void>>(() => Promise.resolve())
    constructor(canvas: HTMLCanvasElement, signal: AbortSignal) {
      this.canvas = canvas
      this.signal = signal
      canvas.dataset.backend = 'webgpu'
      created.push(this)
    }
    static create = vi.fn<(canvas: HTMLCanvasElement, signal: AbortSignal) => Promise<Runtime>>(
      async (canvas: HTMLCanvasElement, signal: AbortSignal) => new Runtime(canvas, signal),
    )
  }
  return { loader, landscape, created, Runtime }
})
vi.mock('./components/gpu-runtime', () => ({ GpuRuntime: fake.Runtime }))
vi.mock('./components/scene-loader', () => ({ initSceneLoader: fake.loader }))
vi.mock('./components/landscape', () => ({ initLandscape: fake.landscape }))

function deferred() {
  let release: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    promise,
    resolve() {
      if (!release) throw new Error('Deferred promise not initialized')
      release()
    },
  }
}
const registrations: { type: string; listener: EventListenerOrEventListenerObject }[] = []
beforeEach(() => {
  vi.resetModules()
  fake.created.length = 0
  fake.Runtime.create.mockClear()
  fake.loader.mockReset().mockResolvedValue({ dispose() {} })
  fake.landscape.mockReset().mockImplementation(async (_host, _renderer, _signal, ready) => {
    ready()
    return () => {}
  })
  document.documentElement.dataset.sceneLoading = 'loading'
  document.body.innerHTML =
    '<main><div id="landscape"><canvas id="scene-canvas"></canvas></div></main>'
  const add = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    registrations.push({ type, listener })
    add(type, listener, options)
  })
})
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  for (const { type, listener } of registrations) window.removeEventListener(type, listener)
  registrations.length = 0
  vi.restoreAllMocks()
})

it('cancels loading before a delayed loader can start the landscape', async () => {
  const waiting = deferred()
  const disposed = vi.fn<() => void>()
  fake.loader.mockImplementation(async () => {
    await waiting.promise
    return { dispose: disposed }
  })
  await import('./main')
  await vi.waitFor(() => expect(fake.loader).toHaveBeenCalledOnce())
  const runtime = fake.created[0]
  if (!runtime) throw new Error('Missing runtime')
  window.dispatchEvent(new Event('pagehide'))
  expect(runtime.signal.aborted).toBe(true)
  expect(runtime.dispose).not.toHaveBeenCalled()
  waiting.resolve()
  await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(runtime.dispose).toHaveBeenCalledOnce())
  expect(fake.landscape).not.toHaveBeenCalled()
})

it('serializes restoration after release and ignores repeated pageshow', async () => {
  await import('./main')
  await vi.waitFor(() => expect(fake.landscape).toHaveBeenCalledOnce())
  const first = fake.created[0]
  if (!first) throw new Error('Missing runtime')
  const release = deferred()
  first.dispose.mockReturnValue(release.promise)
  window.dispatchEvent(new Event('pagehide'))
  window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
  await Promise.resolve()
  expect(fake.Runtime.create).toHaveBeenCalledOnce()
  release.resolve()
  await vi.waitFor(() => expect(fake.landscape).toHaveBeenCalledTimes(2))
  expect(document.documentElement.dataset.sceneLoading).toBe('ready')
  window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
  expect(fake.Runtime.create).toHaveBeenCalledTimes(2)
  expect(document.documentElement.dataset.sceneLoading).toBe('ready')
  expect(fake.landscape.mock.calls[1]?.[5]).toBe(false)
})

it('releases the profile when the WebGPU device fails without creating another renderer', async () => {
  await import('./main')
  await vi.waitFor(() => expect(fake.landscape).toHaveBeenCalledOnce())
  const runtime = fake.created[0]
  if (!runtime?.onFailure) throw new Error('Missing failure callback')
  runtime.onFailure()
  expect(document.documentElement.dataset.sceneLoading).toBe('failed')
  expect(runtime.signal.aborted).toBe(true)
  expect(runtime.dispose).toHaveBeenCalled()
  expect(fake.Runtime.create).toHaveBeenCalledOnce()
})

it('waits for cancelled renderer initialization and release before restoring', async () => {
  const initialized = deferred()
  const released = deferred()
  fake.Runtime.create.mockImplementationOnce(async (canvas, signal) => {
    const runtime = new fake.Runtime(canvas, signal)
    runtime.dispose.mockReturnValue(released.promise)
    await initialized.promise
    return runtime
  })
  await import('./main')
  await vi.waitFor(() => expect(fake.Runtime.create).toHaveBeenCalledOnce())
  const pending = fake.created[0]
  if (!pending) throw new Error('Missing pending renderer')
  window.dispatchEvent(new Event('pagehide'))
  window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
  expect(pending.signal.aborted).toBe(true)
  await Promise.resolve()
  expect(fake.Runtime.create).toHaveBeenCalledOnce()
  expect(fake.loader).not.toHaveBeenCalled()
  initialized.resolve()
  await vi.waitFor(() => expect(pending.dispose).toHaveBeenCalledOnce())
  expect(fake.Runtime.create).toHaveBeenCalledOnce()
  released.resolve()
  await vi.waitFor(() => expect(fake.landscape).toHaveBeenCalledOnce())
  expect(fake.Runtime.create).toHaveBeenCalledTimes(2)
  expect(fake.loader).toHaveBeenCalledOnce()
  expect(document.documentElement.dataset.sceneLoading).toBe('ready')
})

it('aborts on the independent 20-second timeout and ignores a late loader', async () => {
  const loaded = deferred()
  const disposed = vi.fn<() => void>()
  const settled = vi.fn<() => void>()
  window.addEventListener('scene-settled', settled)
  fake.loader.mockImplementation(async () => {
    await loaded.promise
    return { dispose: disposed }
  })
  await import('./main')
  await vi.waitFor(() => expect(fake.loader).toHaveBeenCalledOnce())
  const runtime = fake.created[0]
  if (!runtime) throw new Error('Missing runtime')
  window.dispatchEvent(new Event('scene-timeout'))
  expect(runtime.signal.aborted).toBe(true)
  expect(runtime.dispose).not.toHaveBeenCalled()
  expect(document.documentElement.dataset.sceneLoading).toBe('failed')
  expect(settled).toHaveBeenCalledOnce()
  loaded.resolve()
  await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(runtime.dispose).toHaveBeenCalledOnce())
  expect(fake.landscape).not.toHaveBeenCalled()
  expect(document.documentElement.dataset.sceneLoading).toBe('failed')
})

it('waits for cancelled loader compilation before creating a renderer on restoration', async () => {
  const compiled = deferred()
  const disposeLoader = vi.fn<() => void>()
  fake.loader.mockImplementationOnce(async () => {
    await compiled.promise
    return { dispose: disposeLoader }
  })
  await import('./main')
  await vi.waitFor(() => expect(fake.loader).toHaveBeenCalledOnce())
  const runtime = required(fake.created[0])
  window.dispatchEvent(new Event('pagehide'))
  window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
  expect(runtime.signal.aborted).toBe(true)
  expect(runtime.dispose).not.toHaveBeenCalled()
  await Promise.resolve()
  expect(fake.Runtime.create).toHaveBeenCalledOnce()
  compiled.resolve()
  await vi.waitFor(() => expect(fake.landscape).toHaveBeenCalledOnce())
  expect(disposeLoader).toHaveBeenCalledOnce()
  expect(runtime.dispose).toHaveBeenCalledOnce()
  expect(required(disposeLoader.mock.invocationCallOrder[0])).toBeLessThan(
    required(runtime.dispose.mock.invocationCallOrder[0]),
  )
  expect(fake.Runtime.create).toHaveBeenCalledTimes(2)
  expect(document.documentElement.dataset.sceneLoading).toBe('ready')
})

it('waits for cancelled landscape preparation and teardown before releasing the GPU and restoring', async () => {
  const prepared = deferred()
  const released = deferred()
  const teardown = vi.fn<() => void>()
  const stopLoader = vi.fn<() => void>()
  fake.loader.mockResolvedValueOnce({ dispose: stopLoader })
  fake.landscape.mockImplementationOnce(async () => {
    await prepared.promise
    return teardown
  })
  await import('./main')
  await vi.waitFor(() => expect(fake.landscape).toHaveBeenCalledOnce())
  const runtime = fake.created[0]
  if (!runtime) throw new Error('Missing runtime')
  runtime.dispose.mockReturnValue(released.promise)
  window.dispatchEvent(new Event('pagehide'))
  window.dispatchEvent(new Event('pagehide'))
  expect(runtime.signal.aborted).toBe(true)
  expect(stopLoader).toHaveBeenCalledOnce()
  expect(runtime.dispose).not.toHaveBeenCalled()
  window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
  await Promise.resolve()
  expect(fake.Runtime.create).toHaveBeenCalledOnce()
  prepared.resolve()
  await vi.waitFor(() => expect(runtime.dispose).toHaveBeenCalledOnce())
  expect(teardown).toHaveBeenCalledOnce()
  expect(required(teardown.mock.invocationCallOrder[0])).toBeLessThan(
    required(runtime.dispose.mock.invocationCallOrder[0]),
  )
  expect(fake.Runtime.create).toHaveBeenCalledOnce()
  released.resolve()
  await vi.waitFor(() => expect(fake.landscape).toHaveBeenCalledTimes(2))
  expect(fake.Runtime.create).toHaveBeenCalledTimes(2)
  expect(document.documentElement.dataset.sceneLoading).toBe('ready')
})

it('releases the cancelled GPU after a pending landscape rejects and allows restoration', async () => {
  const prepared = deferred()
  fake.landscape.mockImplementationOnce(async () => {
    await prepared.promise
    throw new Error('Compilation rejected')
  })
  await import('./main')
  await vi.waitFor(() => expect(fake.landscape).toHaveBeenCalledOnce())
  const runtime = fake.created[0]
  if (!runtime) throw new Error('Missing runtime')
  window.dispatchEvent(new Event('pagehide'))
  window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
  expect(runtime.signal.aborted).toBe(true)
  expect(runtime.dispose).not.toHaveBeenCalled()
  prepared.resolve()
  await vi.waitFor(() => expect(fake.landscape).toHaveBeenCalledTimes(2))
  expect(runtime.dispose).toHaveBeenCalledOnce()
  expect(fake.Runtime.create).toHaveBeenCalledTimes(2)
  expect(document.documentElement.dataset.sceneLoading).toBe('ready')
})
