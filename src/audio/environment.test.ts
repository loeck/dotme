import { expect, it } from 'vitest'

import { ambientMix, waterfallSound } from './environment'

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

it('mixes only a present waterfall, leaving headroom through rain and wind', () => {
  const environment = { solarHour: 12, daylight: 1, rainIntensity: 0, windSpeed: 0 }
  expect(ambientMix(environment).waterfall).toBe(0)
  const audible = ambientMix({ ...environment, waterfall: { intensity: 0.7, pan: -0.5 } })
  expect(audible.waterfall).toBeGreaterThan(audible.water)
  expect(audible.water).toBeLessThan(ambientMix(environment).water)
  for (const rainIntensity of [0, 0.5, 1])
    for (const daylight of [0, 0.5, 1])
      for (const intensity of [0, 0.5, 1, NaN, Infinity]) {
        const mix = ambientMix({
          ...environment,
          rainIntensity,
          daylight,
          windSpeed: 12,
          waterfall: { intensity, pan: -1 },
        })
        expect(Object.values(mix).every((value) => Number.isFinite(value) && value >= 0)).toBe(true)
        expect(Object.values(mix).reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(0.9)
      }
})

it('attenuates a distant waterfall and places it on the same side as its visible source', () => {
  const near = waterfallSound(1.8, 2, 10, -0.5)
  const far = waterfallSound(1.8, 2, 50, -0.5)
  expect(far.intensity).toBeLessThan(near.intensity)
  expect(near.pan).toBeLessThan(0)
  expect(waterfallSound(0.7, 2, 10, 0.5).intensity).toBeLessThan(near.intensity)
  expect(waterfallSound(1.8, 2, 10, 0.5).pan).toBeGreaterThan(0)
  expect(waterfallSound(0, 0, 10, 0).intensity).toBe(0)
  expect(waterfallSound(NaN, Infinity, Infinity, NaN)).toEqual({ intensity: 0, pan: 0 })
})
