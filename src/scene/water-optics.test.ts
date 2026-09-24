import { describe, expect, it } from 'vitest'

import { sampleWaterOptics } from './water-optics'

describe('weather-driven water optics', () => {
  it('reduces underwater clarity and increases roughness with rain', () => {
    const calm = sampleWaterOptics(0, 2)
    const rain = sampleWaterOptics(0.5, 2)
    const storm = sampleWaterOptics(1, 8)
    expect(calm.clarity).toBeGreaterThan(rain.clarity)
    expect(rain.clarity).toBeGreaterThan(storm.clarity)
    expect(calm.agitation).toBeLessThan(rain.agitation)
    expect(rain.agitation).toBeLessThan(storm.agitation)
    expect(storm.clarity).toBeGreaterThan(0)
  })

  it('wind roughens reflections without inventing muddy water', () => {
    const calm = sampleWaterOptics(0, 0)
    const windy = sampleWaterOptics(0, 9)
    expect(windy.agitation).toBeGreaterThan(calm.agitation)
    expect(windy.clarity).toBe(calm.clarity)
  })

  it('bounds invalid or extreme inputs', () => {
    expect(sampleWaterOptics(NaN, Infinity)).toEqual(sampleWaterOptics(0, 0))
    expect(sampleWaterOptics(-3, -1)).toEqual(sampleWaterOptics(0, 0))
    expect(sampleWaterOptics(4, 40)).toEqual(sampleWaterOptics(1, 9))
  })
})
