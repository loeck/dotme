import { afterEach, describe, expect, it, vi } from 'vitest'

import { prepareWorldAsync } from './prepare-world'

class FakeWorker extends EventTarget {
  static latest: FakeWorker
  terminated = false
  postMessage = vi.fn<() => void>()
  constructor() {
    super()
    FakeWorker.latest = this
  }
  terminate() {
    this.terminated = true
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})
describe('world preparation lifetime', () => {
  it('terminates pending generation when the component unmounts', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const controller = new AbortController()
    const promise = prepareWorldAsync(9182, false, controller.signal)
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.latest.terminated).toBe(true)
  })
  it('releases the worker after delivery and forwards failures', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const controller = new AbortController()
    const ready = prepareWorldAsync(0, true, controller.signal)
    const worker = FakeWorker.latest
    worker.dispatchEvent(new MessageEvent('message', { data: { seed: 0 } }))
    await expect(ready).resolves.toEqual({ seed: 0 })
    expect(worker.terminated).toBe(true)
    const failed = prepareWorldAsync(0, true, controller.signal)
    FakeWorker.latest.dispatchEvent(new ErrorEvent('error', { message: 'worker failed' }))
    await expect(failed).rejects.toThrow('worker failed')
    expect(FakeWorker.latest.terminated).toBe(true)
  })
})
