import type { Texture, WebGLRenderer } from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProfileLuminance } from './profile-luminance'

function fixture() {
  vi.useFakeTimers()
  let available = false
  let lost = false
  const query = {}
  const gl = {
    ANY_SAMPLES_PASSED: 1,
    QUERY_RESULT_AVAILABLE: 2,
    QUERY_RESULT: 3,
    createQuery: vi.fn<() => object>(() => query),
    deleteQuery: vi.fn<(query: object) => void>(),
    beginQuery: vi.fn<(target: number, query: object) => void>(),
    endQuery: vi.fn<(target: number) => void>(),
    isContextLost: () => lost,
    getQueryParameter: vi.fn<(_query: unknown, name: number) => boolean>((_query, name) => {
      if (name === 2) return available
      if (!available) throw new Error('Blocking query read')
      return true
    }),
  }
  const previous = {}
  const renderer = {
    getContext: () => gl,
    getRenderTarget: () => previous,
    setRenderTarget: vi.fn<(target: unknown) => void>(),
    render: vi.fn<() => void>(),
    toneMappingExposure: 1,
  }
  const meter = new ProfileLuminance()
  const bounds = { left: 0, right: 100, top: 0, bottom: 100, width: 100, height: 100 } as DOMRect
  return {
    meter,
    gl,
    renderer,
    previous,
    available: () => (available = true),
    lose: () => (lost = true),
    read: () =>
      meter.read(renderer as unknown as WebGLRenderer, {} as Texture, bounds, bounds, 0.2),
  }
}

afterEach(() => vi.useRealTimers())

describe('nonblocking backdrop contrast', () => {
  it('waits for availability on later tasks and restores the render target', async () => {
    const f = fixture()
    const result = f.read()
    expect(f.gl.getQueryParameter).not.toHaveBeenCalled()
    expect(f.renderer.setRenderTarget).toHaveBeenLastCalledWith(f.previous)
    await vi.advanceTimersByTimeAsync(64)
    expect(f.gl.getQueryParameter.mock.calls.every((call) => call[1] === 2)).toBe(true)
    f.available()
    await vi.advanceTimersByTimeAsync(16)
    await expect(result).resolves.toBe(true)
    expect(f.gl.deleteQuery).toHaveBeenCalledExactlyOnceWith(
      f.gl.createQuery.mock.results[0]!.value,
    )
    expect(vi.getTimerCount()).toBe(0)
    f.meter.dispose()
  })

  it('cancels pending queries and timers on disposal', async () => {
    const f = fixture()
    const result = f.read().catch((error: Error) => error)
    f.meter.dispose()
    await expect(result).resolves.toMatchObject({ message: 'Backdrop meter disposed' })
    expect(f.gl.deleteQuery).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    await expect(f.read()).rejects.toThrow('unavailable')
  })

  it('rejects context loss without waiting forever', async () => {
    const f = fixture()
    const result = f.read().catch((error: Error) => error)
    f.lose()
    await vi.advanceTimersByTimeAsync(16)
    await expect(result).resolves.toMatchObject({ message: 'Backdrop meter context lost' })
    expect(f.gl.deleteQuery).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    f.meter.dispose()
  })

  it('balances queries and releases them if rendering fails', async () => {
    const f = fixture()
    f.renderer.render.mockImplementation(() => {
      throw new Error('draw failed')
    })
    await expect(f.read()).rejects.toThrow('draw failed')
    expect(f.gl.endQuery).toHaveBeenCalledExactlyOnceWith(f.gl.ANY_SAMPLES_PASSED)
    expect(f.gl.deleteQuery).toHaveBeenCalledTimes(1)
    expect(f.renderer.setRenderTarget).toHaveBeenLastCalledWith(f.previous)
    expect(vi.getTimerCount()).toBe(0)
    f.meter.dispose()
  })

  it('keeps one query in flight', async () => {
    const f = fixture()
    const pending = f.read()
    await expect(f.read()).rejects.toThrow('unavailable')
    f.available()
    await vi.advanceTimersByTimeAsync(16)
    await pending
    expect(f.gl.createQuery).toHaveBeenCalledTimes(1)
    f.meter.dispose()
  })

  it('releases a failed poll and allows the next measurement', async () => {
    const f = fixture()
    f.gl.getQueryParameter.mockImplementationOnce(() => {
      throw new Error('query failed')
    })
    const result = f.read().catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(16)
    await expect(result).resolves.toMatchObject({ message: 'query failed' })
    expect(f.gl.deleteQuery).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    f.available()
    const next = f.read()
    await vi.advanceTimersByTimeAsync(16)
    await expect(next).resolves.toBe(true)
    expect(f.gl.deleteQuery).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    f.meter.dispose()
  })
})
