import { describe, expect, it } from 'vitest'

import { eyeAdaptation, horizonRadiance, refraction, skyIrradiance } from './atmosphere'
import { EARTH, transmittance } from './atmosphere-physics'
import { SKY_TABLE } from './atmosphere-table'
import { sampleLighting } from './lighting'

const sine = (degrees: number) => Math.sin((degrees * Math.PI) / 180)

describe('physical atmosphere', () => {
  it('reddens direct sunlight towards the horizon and blocks it below the ground', () => {
    const noon = transmittance(EARTH.viewerHeight, 1)
    expect(noon[0]).toBeGreaterThan(0.9)
    expect(noon[2]).toBeGreaterThan(0.7)
    const ratios = [60, 20, 8, 3, 0].map((degrees) => {
      const [r, , b] = transmittance(EARTH.viewerHeight, sine(degrees))
      return b / r
    })
    expect(ratios).toEqual(ratios.toSorted((a, b) => b - a))
    expect(transmittance(EARTH.viewerHeight, sine(-3))).toEqual([0, 0, 0])
    // A cloud deck still sees the sun after the viewer has lost it.
    expect(transmittance(2, sine(-1))[0]).toBeGreaterThan(0)
  })
  it('bakes a sorted, finite and positive sky table', () => {
    expect(SKY_TABLE.elevations).toEqual(SKY_TABLE.elevations.toSorted((a, b) => a - b))
    for (const values of [SKY_TABLE.irradiance, SKY_TABLE.horizon]) {
      expect(values).toHaveLength(SKY_TABLE.elevations.length * 3)
      expect(values.every((value) => Number.isFinite(value) && value > 0)).toBe(true)
    }
  })
  it('darkens the sky continuously through twilight, blue overhead and warm at the horizon', () => {
    const levels = [30, 5, 0, -3, -6, -9].map((degrees) => skyIrradiance(sine(degrees))[1])
    expect(levels).toEqual(levels.toSorted((a, b) => b - a))
    const [r, , b] = skyIrradiance(sine(-4))
    expect(b).toBeGreaterThan(r)
    const [hr, , hb] = horizonRadiance(sine(0))
    expect(hr).toBeGreaterThan(hb)
  })
  it('adapts exposure gradually and within bounds', () => {
    expect(eyeAdaptation(0.85)).toBeCloseTo(1, 2)
    const values = [0.85, 0.3, 0.05, 0, -0.05, -0.1, -0.3].map(eyeAdaptation)
    expect(values).toEqual(values.toSorted((a, b) => a - b))
    expect(Math.max(...values)).toBeLessThanOrEqual(48)
  })
  it('lifts and flattens the disc near the horizon only', () => {
    const horizon = refraction(0),
      high = refraction(sine(45))
    expect((horizon.lift * 180) / Math.PI).toBeCloseTo(0.48, 1)
    expect(horizon.flattening).toBeLessThan(0.9)
    expect(high.lift).toBeLessThan(0.0003)
    expect(high.flattening).toBeGreaterThan(0.99)
  })
})

describe('sunrise and sunset lighting', () => {
  it('warms the sun near the horizon and raises its apparent disc', () => {
    const noon = sampleLighting(12 * 3600),
      low = sampleLighting(6.25 * 3600)
    expect(low.sunColor.b / low.sunColor.r).toBeLessThan(noon.sunColor.b / noon.sunColor.r)
    expect(low.sunApparent.y).toBeGreaterThan(low.sunDirection.y)
    expect(low.sunApparent.length()).toBeCloseTo(1, 6)
  })
  it('keeps lighting clouds after sunset, with continuous afterglow', () => {
    const afterglow = sampleLighting(18.1 * 3600)
    expect(afterglow.sunIntensity).toBe(0)
    expect(afterglow.cloudDirect.r).toBeGreaterThan(afterglow.cloudDirect.b)
    expect(afterglow.cloudDirection.y).toBeGreaterThan(0)
    const samples = Array.from({ length: 120 }, (_, i) => sampleLighting((18 + i / 240) * 3600))
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]?.cloudDirect,
        b = samples[i]?.cloudDirect
      expect(Math.abs((a?.r ?? 0) - (b?.r ?? 0))).toBeLessThan(0.08)
    }
  })
  it('never produces non-finite light over a whole day', () => {
    for (let minute = 0; minute < 1440; minute += 5) {
      const light = sampleLighting(minute * 60)
      const values = [
        ...light.sunColor.toArray(),
        ...light.sunDisc.toArray(),
        ...light.ambient.toArray(),
        ...light.haze.toArray(),
        ...light.cloudDirect.toArray(),
        ...light.sunApparent.toArray(),
        light.skyExposure,
        light.sunFlattening,
      ]
      expect(values.every(Number.isFinite)).toBe(true)
    }
  })
})
