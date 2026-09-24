import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { createCloudBodies } from './cloud-density'
import { cloudShadowFrame } from './cloud-shadows'
import { fadeNightLight, sampleLighting } from './lighting'
import { parseInitialTime, SolarClock } from './solar-clock'
import { parseWeather, WEATHER } from './weather'

const fade = (from: number, target: number, fps: number) => {
  let value = from
  for (let frame = 0; frame < fps * 2; frame++) {
    const next = fadeNightLight(value, target, 1 / fps)
    expect(Math.abs(next - value)).toBeLessThan(0.08)
    expect(next).toBeGreaterThanOrEqual(Math.min(from, target))
    expect(next).toBeLessThanOrEqual(Math.max(from, target))
    value = next
  }
  return value
}

describe('visitor solar clock', () => {
  it('scales only the solar cycle, wraps midnight and respects reduced motion', () => {
    for (const scale of [1, 2, 10, 20, 100]) {
      const clock = new SolarClock(86390, false, 1000, scale)
      expect(clock.elapsed(11000)).toBe(10)
      expect(clock.seconds(clock.elapsed(11000))).toBe((86390 + 10 * scale) % 86400)
      const frozen = new SolarClock(30000, true, 1000, scale)
      expect(frozen.seconds(frozen.elapsed(3_601_000))).toBe(30000)
    }
  })
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
  it('fades night lights continuously in either direction, independently of frame rate', () => {
    for (const [from, to] of [
      [0, 1],
      [1, 0],
    ] as const) {
      expect(fade(from, to, 15)).toBeCloseTo(fade(from, to, 60), 8)
      expect(fadeNightLight(from, to, 0, true)).toBe(to)
    }
  })
  it('spreads lamp emergence across twilight rather than switching at sunset', () => {
    const values = [17.5, 17.75, 18, 18.25, 18.5, 18.75].map(
      (hour) => sampleLighting(hour * 3600).localLightStrength,
    )
    expect(values[0]).toBe(0)
    expect(values.at(-1)).toBe(1)
    expect(values.filter((value) => value > 0 && value < 1).length).toBeGreaterThanOrEqual(2)
    expect(values).toEqual(values.toSorted((a, b) => a - b))
  })
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
  it('reserves cursor light for night, independently of weather, with a gradual night transition', () => {
    for (const weather of Object.keys(WEATHER) as Array<keyof typeof WEATHER>) {
      const daytime = Array.from({ length: 288 }, (_, i) =>
        sampleLighting(i * 300, 0, weather),
      ).filter((light) => light.daylight > 0)
      expect(new Set(daytime.map((light) => light.pointerLightStrength))).toEqual(new Set([0]))
      expect(sampleLighting(0, 0, weather).pointerLightStrength).toBe(1)
      const dusk = [18.5, 18.6, 18.75, 19, 19.25].map(
        (hour) => sampleLighting(hour * 3600, 0, weather).pointerLightStrength,
      )
      expect(dusk[0]).toBe(0)
      expect(dusk.at(-1)).toBe(1)
      expect(dusk.filter((value) => value > 0 && value < 1).length).toBeGreaterThanOrEqual(2)
      expect(dusk).toEqual(dusk.toSorted((a, b) => a - b))
      expect(sampleLighting(5.25 * 3600, 0, weather).pointerLightStrength).toBeCloseTo(dusk[2]!)
    }
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
    expect(overcast.uCloudDensity.value).not.toBe(partly.uCloudDensity.value)
    expect(WEATHER.overcast.coverage).toBeGreaterThan(WEATHER['partly-cloudy'].coverage)
    expect(overcast.uCloudRadii.value[0]!.x).toBeGreaterThan(partly.uCloudRadii.value[0]!.x)
  })
})
