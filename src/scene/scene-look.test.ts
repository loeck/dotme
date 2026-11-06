import { describe, expect, it } from 'vitest'

import { goldenHourShare, LAST_SIGNAL_LOOK, sampleLook } from './scene-look'

const elevation = (degrees: number) => Math.sin((degrees * Math.PI) / 180)
const day = { daylight: 1, rain: 0, mist: 0 }

describe('Last Signal scene look', () => {
  it('weights the golden hour from 4° to 14° and fades it out by 26°', () => {
    expect(goldenHourShare(elevation(-2))).toBe(0)
    expect(goldenHourShare(elevation(0))).toBe(0)
    expect(goldenHourShare(elevation(2))).toBeCloseTo(0.5, 5)
    for (const degrees of [4, 9, 14]) expect(goldenHourShare(elevation(degrees))).toBe(1)
    expect(goldenHourShare(elevation(20))).toBeCloseTo(0.5, 5)
    expect(goldenHourShare(elevation(26))).toBe(0)
    expect(goldenHourShare(elevation(60))).toBe(0)
  })

  it('keeps the base grade muted and only lifts it at golden hour', () => {
    const noon = sampleLook({ ...day, sunHeight: elevation(50) })
    expect(noon).toEqual(LAST_SIGNAL_LOOK.base)
    expect(noon.saturation).toBeLessThan(1)
    const golden = sampleLook({ ...day, sunHeight: elevation(8) })
    expect(golden.saturation).toBeCloseTo(0.97 * 1.3, 6)
    expect(golden.contrast).toBeGreaterThan(noon.contrast)
    // Facing a low sun, the air must not wash the depth planes out: no brighter exposure,
    // no thicker or nearer haze, and only a modest lift of the forward glow.
    expect(golden.exposure).toBe(noon.exposure)
    expect(golden.haze).toBeLessThanOrEqual(noon.haze)
    expect(golden.hazeStart).toBe(noon.hazeStart)
    expect(golden.sunScattering).toBeGreaterThan(noon.sunScattering)
    expect(golden.sunScattering).toBeLessThan(noon.sunScattering * 1.2)
    // Warm white balance: red gain above blue.
    expect(golden.tint[0]).toBeGreaterThan(golden.tint[2])
  })

  it('drains colour and thickens the air in rain, deepens the night vignette', () => {
    const dry = sampleLook({ ...day, sunHeight: elevation(50) })
    const wet = sampleLook({ ...day, rain: 1, sunHeight: elevation(50) })
    expect(wet.saturation).toBeLessThan(dry.saturation)
    expect(wet.haze).toBeGreaterThan(dry.haze)
    expect(wet.mist).toBeGreaterThan(dry.mist)
    const night = sampleLook({ daylight: 0, rain: 0, mist: 0, sunHeight: elevation(-30) })
    expect(night.vignette).toBeGreaterThan(dry.vignette)
    expect(night.tint[2]).toBeGreaterThan(night.tint[0])
  })

  it('lets lamps glow at night and the low sun bloom at golden hour', () => {
    const noon = sampleLook({ ...day, sunHeight: elevation(50) })
    const golden = sampleLook({ ...day, sunHeight: elevation(8) })
    const night = sampleLook({ daylight: 0, rain: 0, mist: 0, sunHeight: elevation(-30) })
    expect(golden.glow).toBeGreaterThan(noon.glow)
    expect(golden.split).toBeGreaterThan(noon.split)
    expect(golden.glowThreshold).toBe(noon.glowThreshold)
    expect(night.glowThreshold).toBeLessThan(noon.glowThreshold / 2)
    expect(night.glow).toBeGreaterThan(noon.glow)
  })

  it('stays finite and bounded for any input', () => {
    for (const sunHeight of [-1, -0.2, 0, 0.1, 0.5, 1, 2, -2])
      for (const value of [0, 0.5, 1, 4, -1]) {
        const look = sampleLook({ sunHeight, daylight: value, rain: value, mist: value })
        for (const number of Object.values(look).filter((v) => typeof v === 'number'))
          expect(Number.isFinite(number)).toBe(true)
        expect(look.vignette).toBeGreaterThanOrEqual(0)
        expect(look.vignette).toBeLessThan(1)
        expect(look.saturation).toBeGreaterThan(0)
        expect(look.mist).toBeGreaterThan(0)
      }
  })
})
