import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { createCloudBodies } from './cloud-density'
import { cloudShadowFrame } from './cloud-shadows'
import { sampleLighting } from './lighting'
import { parseInitialTime, SolarClock } from './solar-clock'
import { parseWeather, WEATHER } from './weather'

describe('visitor solar clock', () => {
  it('accepts only HH:MM and falls back to visitor local time', () => {
    const local = new Date(2026, 8, 23, 14, 32, 17)
    expect(parseInitialTime('08:30', local)).toBe(30600)
    for (const invalid of [null, '', '24:00', '12:60', '8:30', '12:30extra'])
      expect(parseInitialTime(invalid, local)).toBe(52337)
  })
  it('advances at wall-clock speed after suspension and freezes with reduced motion', () => {
    const clock = new SolarClock(86390, false, 1000)
    expect(clock.seconds(clock.elapsed(31000))).toBe(20)
    expect(clock.elapsed(3_601_000)).toBe(3600)
    expect(new SolarClock(30000, true, 1000).elapsed(3_601_000)).toBe(0)
  })
})

describe('solar lighting and light-space projection', () => {
  it('rises at six, peaks at noon, sets at eighteen and disables sunlight at night', () => {
    expect(sampleLighting(6 * 3600).sunDirection.y).toBeCloseTo(0)
    expect(sampleLighting(12 * 3600).sunDirection.y).toBeGreaterThan(0.8)
    expect(sampleLighting(18 * 3600).sunDirection.y).toBeCloseTo(0)
    expect(sampleLighting(0).sunIntensity).toBe(0)
    expect(sampleLighting(0).moonIntensity).toBeGreaterThan(1)
  })
  it('is continuous through sunrise, sunset and midnight without non-finite projections', () => {
    for (const boundary of [0, 6 * 3600, 18 * 3600, 86400]) {
      const before = sampleLighting(boundary, -0.001)
      const after = sampleLighting(boundary, 0.001)
      expect(before.sunDirection.distanceTo(after.sunDirection)).toBeLessThan(0.00001)
      expect(Math.abs(before.sunIntensity - after.sunIntensity)).toBeLessThan(0.00001)
      expect(Math.abs(before.moonIntensity - after.moonIntensity)).toBeLessThan(0.00001)
      expect(cloudShadowFrame(after.direction).matrix.elements.every(Number.isFinite)).toBe(true)
    }
  })
  it('only enables local lights in low ambient illumination, including weather', () => {
    for (const weather of Object.keys(WEATHER) as Array<keyof typeof WEATHER>) {
      expect(sampleLighting(0, 0, weather).localLightStrength).toBe(1)
      for (const hour of [8.5, 12, 17.5])
        expect(sampleLighting(hour * 3600, 0, weather).localLightStrength).toBe(0)
    }
    const dawn = sampleLighting(5.75 * 3600, 0, 'clear')
    expect(dawn.localLightStrength).toBeGreaterThan(0)
    expect(dawn.localLightStrength).toBeLessThan(1)
    expect(sampleLighting(5.75 * 3600, 0, 'overcast').localLightStrength).toBeGreaterThan(
      dawn.localLightStrength,
    )
    expect(
      Math.abs(
        sampleLighting(5.75 * 3600, 0.001).localLightStrength -
          sampleLighting(5.75 * 3600, -0.001).localLightStrength,
      ),
    ).toBeLessThan(0.0001)
  })
  it('projects every point along a light ray to the same UV, including the horizon', () => {
    for (const direction of [
      new Vector3(1, 0, 0),
      new Vector3(0, 1, 0),
      new Vector3(1, 0.001, -1).normalize(),
    ]) {
      const { matrix } = cloudShadowFrame(direction)
      const p = new Vector3(16, 23, -70)
      const a = p.clone().applyMatrix4(matrix)
      const b = p.addScaledVector(direction, 200).applyMatrix4(matrix)
      expect(a.x).toBeCloseTo(b.x, 12)
      expect(a.y).toBeCloseTo(b.y, 12)
    }
  })
  it('keeps weather deterministic and changes density as well as cloud shape', () => {
    expect(parseWeather('invalid')).toBe('partly-cloudy')
    expect(parseWeather('clear')).toBe('clear')
    expect(WEATHER.clear.density).toBe(0)
    const partly = createCloudBodies(9182)
    expect(createCloudBodies(9182)).toEqual(partly)
    const overcast = createCloudBodies(9182, 'overcast')
    expect(overcast.uCloudDensity.value).toBeGreaterThan(partly.uCloudDensity.value)
    expect(overcast.uCloudRadii.value[0]!.x).toBeGreaterThan(partly.uCloudRadii.value[0]!.x)
  })
})
