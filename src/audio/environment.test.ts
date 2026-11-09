import { expect, it } from 'vitest'

import {
  ambientMix,
  ambientTone,
  birdChorus,
  insectRate,
  insectWarmth,
  stormy,
  waterfallSound,
} from './environment'

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

const at = (daylight: number, solarHour: number, rainIntensity = 0, windSpeed = 0) => ({
  daylight,
  solarHour,
  rainIntensity,
  windSpeed,
})

it('sings a dawn chorus at morning twilight and keeps owls to a dry, dark night', () => {
  expect(birdChorus(at(0.4, 6))).toBe(1)
  expect(birdChorus(at(0.4, 19))).toBeCloseTo(0.45)
  expect(birdChorus(at(1, 12))).toBe(0)
  expect(birdChorus(at(0, 2))).toBe(0)
  expect(birdChorus(at(0.4, 6, 1))).toBe(0)
  expect(birdChorus(at(NaN, NaN, NaN))).toBe(0)
  const dawn = ambientMix(at(0.4, 6))
  const noon = ambientMix(at(1, 12))
  expect(dawn.birds).toBeGreaterThan(noon.birds)
  expect(ambientMix(at(0.1, 6)).birds).toBeLessThan(dawn.birds)
  expect(noon.owls).toBe(0)
  expect(ambientMix(at(0, 1)).owls).toBeGreaterThan(0.1)
  expect(ambientMix(at(0, 1, 1)).owls).toBe(0)
  expect(ambientMix(at(0, 1, 0, 12)).owls).toBeLessThan(ambientMix(at(0, 1)).owls)
})

it('follows rain perceptually, silences crickets in the cold and damps fog and snow', () => {
  const night = { solarHour: 1, daylight: 0, windSpeed: 0, rainIntensity: 0.25 }
  // Square-root loudness: a quarter of the rain is heard at half the full level.
  expect(ambientMix(night).rain).toBeCloseTo(0.21)
  expect(ambientMix({ ...night, snow: 1 }).rain).toBe(0)
  expect(insectWarmth(undefined)).toBe(1)
  expect(insectWarmth(7)).toBe(0)
  expect(insectWarmth(10)).toBeCloseTo(0.5)
  expect(insectWarmth(13)).toBe(1)
  expect(ambientMix({ ...night, temperature: 5 }).insects).toBe(0)
  expect(ambientMix({ ...night, temperature: 20 }).insects).toBe(ambientMix(night).insects)
  expect(insectRate(20)).toBe(1)
  expect(insectRate(40)).toBe(1.15)
  expect(insectRate(-10)).toBe(0.9)
  expect(insectRate(Number.NaN)).toBe(1)
  const day = { solarHour: 12, daylight: 1, windSpeed: 0, rainIntensity: 0 }
  expect(ambientMix({ ...day, fog: 1 }).birds).toBeCloseTo(ambientMix(day).birds * 0.4)
  expect(ambientTone(day).masterShelf).toBe(-0)
  expect(ambientTone({ ...day, snow: 0.5 }).masterShelf).toBe(-7)
  expect(ambientTone({ ...day, rainIntensity: 0 }).rainCutoff).toBe(1200)
  expect(ambientTone({ ...day, rainIntensity: 1 }).rainCutoff).toBeCloseTo(11_000)
  expect(ambientTone({ ...day, daylight: 0 }).reverb).toBeGreaterThan(ambientTone(day).reverb)
  expect(ambientTone(day).windPan).toBe(0)
  expect(ambientTone({ ...day, windPan: -2 }).windPan).toBe(-0.6)
  expect(stormy({ ...day, rainIntensity: 0.8 })).toBe(true)
  expect(stormy({ ...day, storm: true })).toBe(true)
  expect(stormy({ ...day, rainIntensity: 0.5 })).toBe(false)
})

it('thins the birds and silences the crickets in winter', () => {
  const day = { solarHour: 12, daylight: 1, windSpeed: 0, rainIntensity: 0 }
  const night = { ...day, solarHour: 23, daylight: 0 }
  expect(ambientMix({ ...day, winter: 1 }).birds).toBeCloseTo(ambientMix(day).birds * 0.4)
  expect(ambientMix({ ...night, winter: 1 }).insects).toBe(0)
  expect(ambientMix({ ...night, winter: 0 }).insects).toBe(ambientMix(night).insects)
  expect(ambientMix({ ...night, winter: Number.NaN }).insects).toBe(ambientMix(night).insects)
})
