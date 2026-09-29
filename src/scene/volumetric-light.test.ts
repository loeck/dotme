import { describe, expect, it } from 'vitest'

import { airElevationScale, airSunScale } from './volumetric-light'

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
})
