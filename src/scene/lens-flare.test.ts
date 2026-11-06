import { describe, expect, it } from 'vitest'

import { flareStrength } from './lens-flare'

describe('lens flare', () => {
  it('flares only for a sun up and in or near the frame, more when low', () => {
    const centre = { x: 0.2, y: 0.1, z: 0.99 }
    expect(flareStrength(centre, 0.2)).toBeGreaterThan(flareStrength(centre, 0.8))
    expect(flareStrength(centre, 0.8)).toBeGreaterThan(0)
    expect(flareStrength(centre, -0.05)).toBe(0)
    // Fades out over the last 30% beyond the frame edge, and never behind the camera.
    expect(flareStrength({ x: 1.15, y: 0, z: 0.99 }, 0.2)).toBeLessThan(flareStrength(centre, 0.2))
    expect(flareStrength({ x: 1.4, y: 0, z: 0.99 }, 0.2)).toBe(0)
    expect(flareStrength({ x: 0, y: 0, z: 1.01 }, 0.2)).toBe(0)
    expect(flareStrength({ x: Number.NaN, y: 0, z: 0.5 }, 0.2)).toBe(0)
  })
})
