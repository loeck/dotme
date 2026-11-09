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
const preload = vi.hoisted(() => vi.fn<(lowPower: boolean) => void>())
vi.mock('../scene/terrain-images', () => ({ preloadTerrainImages: preload }))

const { nextWorldAllowed, prepareNextWorld, startSceneWorld } = await import('./scene-world')
type Environment = Parameters<typeof nextWorldAllowed>[1] & object

const desktop = (overrides: Partial<Environment> = {}): Environment => ({
  saveData: false,
  lowPower: false,
  hidden: false,
  estimate: () => Promise.resolve({ usage: 0, quota: 1e9 }),
  ...overrides,
})

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
    // The terrain scans start downloading with the world.
    expect(preload).toHaveBeenCalled()
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
    prepareNextWorld(world(false), controller.signal, desktop)
    await vi.advanceTimersByTimeAsync(3000)
    expect(fake.store).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3000)
    expect(fake.store).toHaveBeenCalledTimes(1)
    const [seed, mobile] = fake.store.mock.calls[0] ?? []
    expect(mobile).toBe(true)
    expect(localStorage.getItem(NEXT)).toBe(String(seed))
  })
  it('keeps a URL seed, and skips it when it already came from the cache', async () => {
    prepareNextWorld(world(true), new AbortController().signal, desktop)
    await vi.advanceTimersByTimeAsync(6000)
    expect(fake.store.mock.calls[0]?.[0]).toBe(9)
    expect(localStorage.getItem(NEXT)).toBeNull()
    fake.store.mockClear()
    fake.fromCache = true
    prepareNextWorld(world(true), new AbortController().signal, desktop)
    await vi.advanceTimersByTimeAsync(6000)
    expect(fake.store).not.toHaveBeenCalled()
  })
  it('stops with the scene', async () => {
    const controller = new AbortController()
    prepareNextWorld(world(false), controller.signal, desktop)
    controller.abort()
    await vi.advanceTimersByTimeAsync(6000)
    expect(fake.store).not.toHaveBeenCalled()
  })
  it('skips the next world where the guards say so', async () => {
    for (const env of [
      desktop({ saveData: true }),
      desktop({ lowPower: true }),
      desktop({ hidden: true }),
      desktop({ estimate: () => Promise.resolve({ usage: 495e6, quota: 1e9 }) }),
    ]) {
      prepareNextWorld(world(false), new AbortController().signal, () => env)
      // eslint-disable-next-line no-await-in-loop -- each case runs its own timers
      await vi.advanceTimersByTimeAsync(6000)
    }
    expect(fake.store).not.toHaveBeenCalled()
    expect(localStorage.getItem(NEXT)).toBeNull()
  })
})

const quota = (usage: number) =>
  desktop({ estimate: () => Promise.resolve({ usage, quota: 200e6 }) })

describe('next world guards', () => {
  it('keeps a stored world within half of the quota', async () => {
    // A desktop world is budgeted at 40 MB deflated.
    await expect(nextWorldAllowed(false, quota(60e6))).resolves.toBe(true)
    await expect(nextWorldAllowed(false, quota(61e6))).resolves.toBe(false)
    // Phones budget 10 MB, but a low-power device never prepares one.
    await expect(nextWorldAllowed(true, quota(90e6))).resolves.toBe(true)
    await expect(nextWorldAllowed(true, { ...quota(0), lowPower: true })).resolves.toBe(false)
  })
  it('does not count the stored world that the next one replaces', async () => {
    const replacing = (stored: () => Promise<number>) => ({ ...quota(80e6), stored })
    await expect(nextWorldAllowed(false, quota(80e6))).resolves.toBe(false)
    await expect(
      nextWorldAllowed(
        false,
        replacing(() => Promise.resolve(30e6)),
      ),
    ).resolves.toBe(true)
    await expect(
      nextWorldAllowed(
        false,
        replacing(() => Promise.reject(new Error('no'))),
      ),
    ).resolves.toBe(false)
  })
  it('does not block on a missing or failing estimate', async () => {
    await expect(
      nextWorldAllowed(false, desktop({ estimate: () => Promise.resolve(undefined) })),
    ).resolves.toBe(true)
    await expect(
      nextWorldAllowed(false, desktop({ estimate: () => Promise.reject(new Error('no')) })),
    ).resolves.toBe(true)
    await expect(
      nextWorldAllowed(false, desktop({ estimate: () => Promise.resolve({ usage: 5 }) })),
    ).resolves.toBe(true)
  })
  it('reads save-data, visibility and storage from the browser', async () => {
    vi.stubGlobal('innerWidth', 1280)
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    Object.defineProperty(navigator, 'connection', {
      value: { saveData: true },
      configurable: true,
    })
    await expect(nextWorldAllowed(false)).resolves.toBe(false)
    Object.defineProperty(navigator, 'connection', {
      value: { saveData: false },
      configurable: true,
    })
    await expect(nextWorldAllowed(false)).resolves.toBe(true)
    Reflect.deleteProperty(navigator, 'connection')
  })
})
