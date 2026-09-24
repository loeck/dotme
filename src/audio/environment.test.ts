import { expect, it } from 'vitest'

import { ambientMix } from './environment'

it('follows day, rain and wind while keeping a conservative combined gain ceiling', () => {
  for (const daylight of [-1, 0, 0.5, 1, 2, NaN])
    for (const rainIntensity of [0, 0.5, 1, Infinity])
      for (const windSpeed of [0, 3, 12, 100]) {
        const mix = ambientMix({ solarHour: 12, daylight, rainIntensity, windSpeed })
        expect(Object.values(mix).every((v) => Number.isFinite(v) && v >= 0)).toBe(true)
        expect(Object.values(mix).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(0.9)
      }
  const day = ambientMix({ solarHour: 12, daylight: 1, rainIntensity: 0, windSpeed: 0 })
  const night = ambientMix({ solarHour: 0, daylight: 0, rainIntensity: 1, windSpeed: 12 })
  expect(day.insects).toBe(0)
  expect(night.birds).toBe(0)
  expect(night.rain).toBe(0.42)
  expect(night.water).toBeLessThan(day.water)
  expect(night.rain).toBeGreaterThan(night.water * 4)
  const shower = ambientMix({ solarHour: 12, daylight: 1, rainIntensity: 0.5, windSpeed: 3 })
  expect(shower.rain).toBeGreaterThan(shower.water * 1.7)
  const windy = ambientMix({ solarHour: 12, daylight: 1, rainIntensity: 0, windSpeed: 12 })
  expect(windy.water).toBeGreaterThan(day.water)
})
