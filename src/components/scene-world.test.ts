// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  fromCache: false,
  prepare: vi.fn<(seed: number, mobile: boolean, signal: AbortSignal) => Promise<unknown>>(),
  store: vi.fn<(seed: number, mobile: boolean, signal: AbortSignal) => Promise<void>>(),
}))
vi.mock('../scene/prepare-world', () => ({
  WORLD_CACHE: true,
  prepareWorldAsync: fake.prepare,
  storeWorldAsync: fake.store,
}))

const { prepareNextWorld, startSceneWorld } = await import('./scene-world')

const NEXT = 'dotme:next-world-seed'
const world = (requested: boolean) => ({
  seed: 9,
  mobile: true,
  requested,
  prepared: Promise.resolve({ fromCache: Promise.resolve(fake.fromCache) }),
})

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  history.replaceState(null, '', '/')
  fake.prepare
    .mockReset()
    .mockImplementation(() => Promise.resolve({ fromCache: Promise.resolve(fake.fromCache) }))
  fake.store.mockReset().mockResolvedValue()
  fake.fromCache = false
  vi.stubGlobal('Worker', EventTarget)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('scene world seed', () => {
  it('prefers the URL seed and keeps a host on its world across restarts', () => {
    history.replaceState(null, '', '/?seed=77')
    localStorage.setItem(NEXT, '5')
    const host = document.createElement('div')
    const signal = new AbortController().signal
    expect(startSceneWorld(host, signal)).toMatchObject({ seed: 77, requested: true })
    history.replaceState(null, '', '/')
    expect(startSceneWorld(host, signal)).toMatchObject({ seed: 77, requested: false })
    expect(fake.prepare.mock.calls.map(([seed]) => seed)).toEqual([77, 77])
  })
  it('takes the prepared next seed once', () => {
    localStorage.setItem(NEXT, '5')
    const signal = new AbortController().signal
    expect(startSceneWorld(document.createElement('div'), signal).seed).toBe(5)
    expect(localStorage.getItem(NEXT)).toBeNull()
    expect(startSceneWorld(document.createElement('div'), signal).seed).not.toBe(5)
  })
})

describe('next world', () => {
  it('stores a new seed after the delay and remembers it once stored', async () => {
    const controller = new AbortController()
    prepareNextWorld(world(false), controller.signal)
    await vi.advanceTimersByTimeAsync(3000)
    expect(fake.store).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3000)
    expect(fake.store).toHaveBeenCalledTimes(1)
    const [seed, mobile] = fake.store.mock.calls[0] ?? []
    expect(mobile).toBe(true)
    expect(localStorage.getItem(NEXT)).toBe(String(seed))
  })
  it('keeps a URL seed, and skips it when it already came from the cache', async () => {
    prepareNextWorld(world(true), new AbortController().signal)
    await vi.advanceTimersByTimeAsync(6000)
    expect(fake.store.mock.calls[0]?.[0]).toBe(9)
    expect(localStorage.getItem(NEXT)).toBeNull()
    fake.store.mockClear()
    fake.fromCache = true
    prepareNextWorld(world(true), new AbortController().signal)
    await vi.advanceTimersByTimeAsync(6000)
    expect(fake.store).not.toHaveBeenCalled()
  })
  it('stops with the scene', async () => {
    const controller = new AbortController()
    prepareNextWorld(world(false), controller.signal)
    controller.abort()
    await vi.advanceTimersByTimeAsync(6000)
    expect(fake.store).not.toHaveBeenCalled()
  })
})
