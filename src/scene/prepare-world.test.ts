import { afterEach, describe, expect, it, vi } from 'vitest'

import { prepareWorldAsync } from './prepare-world'

class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = []
  terminated = false
  postMessage = vi.fn<(message: unknown) => void>()
  constructor() {
    super()
    FakeWorker.instances.push(this)
  }
  terminate() {
    this.terminated = true
  }
  deliver(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }
}

/** The worker asked for one part of the world, by its request message. */
function workerFor(part: string) {
  const worker = FakeWorker.instances.find((candidate) =>
    JSON.stringify(candidate.postMessage.mock.calls[0]?.[0]).includes(`"part":"${part}"`),
  )
  if (!worker) throw new Error(`No worker prepares ${part}`)
  return worker
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeWorker.instances = []
})
describe('world preparation lifetime', () => {
  it('splits generation across two workers and terminates both on unmount', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const controller = new AbortController()
    const promise = prepareWorldAsync(9182, false, controller.signal)
    expect(FakeWorker.instances).toHaveLength(2)
    expect(FakeWorker.instances.map((worker) => worker.postMessage.mock.calls[0]?.[0])).toEqual([
      { seed: 9182, mobile: false, part: 'terrain' },
      { seed: 9182, mobile: false, part: 'surfaces' },
    ])
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.instances.every((worker) => worker.terminated)).toBe(true)
  })
  it('combines both parts, releasing each worker as it delivers', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const controller = new AbortController()
    const ready = prepareWorldAsync(0, true, controller.signal)
    const surfaces = workerFor('surfaces')
    surfaces.deliver({ part: 'surfaces', data: { noise: 1 } })
    expect(surfaces.terminated).toBe(true)
    expect(workerFor('terrain').terminated).toBe(false)
    workerFor('terrain').deliver({ part: 'terrain', data: { world: 2 } })
    await expect(ready).resolves.toEqual({ noise: 1, world: 2 })
    expect(FakeWorker.instances.every((worker) => worker.terminated)).toBe(true)
  })
  it('forwards a failure from either worker and stops the other', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const controller = new AbortController()
    const failed = prepareWorldAsync(0, true, controller.signal)
    workerFor('terrain').dispatchEvent(
      Object.assign(new Event('error'), { message: 'worker failed' }),
    )
    await expect(failed).rejects.toThrow('worker failed')
    expect(FakeWorker.instances.every((worker) => worker.terminated)).toBe(true)
  })
})
