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
  it('keeps every passage, connects fast movement and stays put while stationary', () => {
    const trace = new SkyCursorTrace(256)
    const start = { x: -0.6, y: 0.8, z: 0 }
    const end = { x: 0.6, y: 0.8, z: 0 }
    trace.update(start)
    trace.update(end)
    expect(intensity(trace, 0, 1, 0)).toBeGreaterThan(200)
    trace.texture.needsUpdate = false
    const version = trace.texture.version
    for (let i = 0; i < 90; i++) trace.update(end)
    expect(trace.texture.version).toBe(version)
    expect(intensity(trace, end.x, end.y, end.z)).toBeGreaterThan(200)
    expect(intensity(trace, start.x, start.y, start.z)).toBeGreaterThan(200)
    trace.dispose()
  })

  it('ends strokes on invalid sky input without erasing earlier ones', () => {
    const trace = new SkyCursorTrace(256)
    trace.update({ x: -0.6, y: 0.8, z: 0 })
    trace.update(null)
    trace.update({ x: 0.6, y: 0.8, z: 0 })
    expect(intensity(trace, 0, 1, 0)).toBe(0)
    for (let i = 0; i < 600; i++) trace.update(null)
    expect(intensity(trace, -0.6, 0.8, 0)).toBeGreaterThan(200)
    expect(intensity(trace, 0.6, 0.8, 0)).toBeGreaterThan(200)
    trace.clear()
    expect(intensity(trace, 0.6, 0.8, 0)).toBe(0)
    trace.dispose()
  })
})
