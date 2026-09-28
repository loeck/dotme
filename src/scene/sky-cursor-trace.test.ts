import { describe, expect, it } from 'vitest'

import { SkyCursorTrace } from './sky-cursor-trace'

function intensity(trace: SkyCursorTrace, x: number, y: number, z: number) {
  const size = trace.texture.image.width
  const col = Math.floor((0.5 + x / (2 * (1 + y))) * size)
  const row = Math.floor((0.5 + z / (2 * (1 + y))) * size)
  const data = trace.texture.image.data
  if (!data) throw new Error('Missing sky trace pixels')
  return data[row * size + col] ?? 0
}

describe('sky cursor trace', () => {
  it('connects fast movement and keeps a stationary opening while held', () => {
    const trace = new SkyCursorTrace(256)
    const start = { x: -0.6, y: 0.8, z: 0 }
    const end = { x: 0.6, y: 0.8, z: 0 }
    trace.update(start, 0)
    trace.update(end, 0)
    expect(intensity(trace, 0, 1, 0)).toBeGreaterThan(200)
    for (let i = 0; i < 90; i++) trace.update(end, 1 / 30)
    expect(intensity(trace, end.x, end.y, end.z)).toBeGreaterThan(200)
    expect(intensity(trace, start.x, start.y, start.z)).toBe(0)
    trace.dispose()
  })

  it('heals each passage on its own clock without clearing on release', () => {
    const trace = new SkyCursorTrace(256)
    const first = { x: -0.6, y: 0.8, z: 0 }
    const second = { x: 0.6, y: 0.8, z: 0 }
    trace.update(first, 0)
    trace.update(null, 1 / 60)
    expect(intensity(trace, first.x, first.y, first.z)).toBeGreaterThan(200)
    for (let i = 0; i < 20; i++) trace.update(null, 0.1)
    const healing = intensity(trace, first.x, first.y, first.z)
    expect(healing).toBeGreaterThan(40)
    expect(healing).toBeLessThan(160)
    trace.update(second, 0)
    trace.update(null, 0)
    expect(intensity(trace, 0, 1, 0)).toBe(0)
    for (let i = 0; i < 12; i++) trace.update(null, 0.1)
    expect(intensity(trace, first.x, first.y, first.z)).toBe(0)
    expect(intensity(trace, second.x, second.y, second.z)).toBeGreaterThan(40)
    for (let i = 0; i < 20; i++) trace.update(null, 0.1)
    expect(intensity(trace, second.x, second.y, second.z)).toBe(0)
    trace.update(second, 0)
    trace.clear()
    expect(intensity(trace, second.x, second.y, second.z)).toBe(0)
    trace.dispose()
  })
})
