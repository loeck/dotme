import { describe, expect, it } from 'vitest'

import { airElevationScale, airSunScale, shaftDensity } from './volumetric-light'

describe('volumetric air sun scale', () => {
  it('keeps full sun shafts by day and dims moonlit air at night', () => {
    expect(airSunScale(1)).toBe(1)
    expect(airSunScale(0)).toBe(0.35)
    const values = [0, 0.25, 0.5, 0.75, 1].map(airSunScale)
    expect(values).toEqual(values.toSorted((a, b) => a - b))
  })

  it('tempers high-sun air flood while keeping golden-hour and moon glow', () => {
    expect(airElevationScale(0.85, 1)).toBeLessThan(0.2)
    expect(airElevationScale(0.1, 1)).toBeGreaterThan(0.95)
    expect(airElevationScale(0.42, 0)).toBe(1)
    const noon = [0.1, 0.3, 0.5, 0.7, 0.9].map((y) => airElevationScale(y, 1))
    expect(noon).toEqual(noon.toSorted((a, b) => b - a))
  })

  it('keeps the beam aerosol thin, thicker at golden hour and absent at night or overcast', () => {
    const golden = shaftDensity(Math.sin((10 * Math.PI) / 180), 1, 0.9)
    const noon = shaftDensity(0.8, 1, 0.9)
    expect(golden).toBeGreaterThan(noon)
    // Clear air: under a fifth of the light lost over 120 m of beam at most.
    expect(Math.exp(-golden * 120)).toBeGreaterThan(0.8)
    expect(shaftDensity(0.8, 0, 0.9)).toBe(0)
    expect(shaftDensity(0.8, 1, 0.5)).toBe(0)
  })
})
