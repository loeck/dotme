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
  it('keeps a stationary opening, connects fast movement, and retains earlier passages', () => {
    const trace = new SkyCursorTrace(256)
    const start = { x: -0.6, y: 0.8, z: 0 }
    const end = { x: 0.6, y: 0.8, z: 0 }
    trace.update(start, 1 / 30)
    trace.update(end, 1 / 30)
    expect(intensity(trace, 0, 1, 0)).toBeGreaterThan(200)
    for (let i = 0; i < 90; i++) trace.update(end, 1 / 30)
    expect(intensity(trace, end.x, end.y, end.z)).toBeGreaterThan(200)
    expect(intensity(trace, start.x, start.y, start.z)).toBe(0)
    trace.update({ x: 0, y: 1, z: 0 }, 0)
    for (let i = 0; i < 12; i++) {
      const angle = (i * Math.PI) / 6
      trace.update(
        {
          x: Math.sin(0.6) * Math.cos(angle),
          y: Math.cos(0.6),
          z: Math.sin(0.6) * Math.sin(angle),
        },
        0,
      )
    }
    expect(intensity(trace, 0, 1, 0)).toBeGreaterThan(0)
    trace.dispose()
  })

  it('ends strokes on invalid sky input and fully refills after three seconds', () => {
    const trace = new SkyCursorTrace(256)
    trace.update({ x: -0.6, y: 0.8, z: 0 }, 0)
    trace.update(null, 0)
    trace.update({ x: 0.6, y: 0.8, z: 0 }, 0)
    expect(intensity(trace, 0, 1, 0)).toBe(0)
    for (let i = 0; i < 37; i++) trace.update(null, 1 / 12)
    expect(intensity(trace, 0.6, 0.8, 0)).toBe(0)
    trace.update({ x: 0.6, y: 0.8, z: 0 }, 0)
    trace.clear()
    expect(intensity(trace, 0.6, 0.8, 0)).toBe(0)
    trace.dispose()
  })
})
