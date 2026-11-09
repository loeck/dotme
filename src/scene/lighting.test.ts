import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { required } from '../invariant'
import { createCloudBodies } from './cloud-density'
import { cloudShadowFrame } from './cloud-shadows'
import { fadeNightLight, mistFactor, MOON_SWEEP, moonPath, sampleLighting } from './lighting'
import {
  INTRO_ARC_SHARE,
  INTRO_DURATION,
  INTRO_HOLD,
  introGap,
  introRemaining,
  parseInitialTime,
  SolarClock,
} from './solar-clock'
import { WEATHER } from './weather'

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

const azimuth = (v: Vector3) => Math.atan2(v.x, -v.z)

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
  it('opens on the latest golden hour and lands on the real time', () => {
    const solar = { sunrise: 7 * 3600, sunset: 19 * 3600 }
    const lead = 12 * 3600 * INTRO_ARC_SHARE
    // Mid-morning replays from the morning golden hour, a night from the evening one.
    expect(introGap(10 * 3600, solar)).toBeCloseTo(3 * 3600 - lead, 6)
    expect(introGap(23 * 3600, solar)).toBeCloseTo(4 * 3600 + lead, 6)
    // Before sunrise the evening is the latest golden hour, across midnight.
    expect(introGap(5 * 3600, solar)).toBeCloseTo(10 * 3600 + lead, 6)
    // A visit already in the golden hour is not replayed.
    expect(introGap(solar.sunset - lead + 300, solar)).toBe(0)
    // Ill-formed endpoints fall back to the default day.
    expect(introGap(10 * 3600, { sunrise: 5, sunset: 2 })).toBe(introGap(10 * 3600))
    for (const now of [0, 3600, 30_000, 50_000, 86_399])
      expect(introGap(now, solar)).toBeLessThan(86_400)

    const now = 10 * 3600
    const clock = new SolarClock(now, false, 1000, 1, introGap(now, solar))
    const opening = clock.seconds(0)
    expect(opening).toBeCloseTo(7 * 3600 + lead, 6)
    // The opening holds, then the replay only ever moves forward.
    expect(clock.seconds(INTRO_HOLD)).toBeCloseTo(opening + INTRO_HOLD, 6)
    let previous = opening
    for (let t = 0.25; t <= INTRO_DURATION + 2; t += 0.25) {
      const value = clock.seconds(t)
      expect(value).toBeGreaterThanOrEqual(previous)
      previous = value
    }
    expect(clock.seconds(INTRO_DURATION)).toBeCloseTo(now + INTRO_DURATION, 6)
    expect(clock.seconds(INTRO_DURATION + 60)).toBeCloseTo(now + INTRO_DURATION + 60, 6)
    expect(introRemaining(0)).toBe(1)
    expect(introRemaining(INTRO_DURATION)).toBe(0)
  })
  it('restarts the intro at the first frame and skips it with reduced motion', () => {
    const clock = new SolarClock(36_000, false, 1000, 1, 3600)
    const restarted = clock.restartIntro(6000)
    // Loading time still counts towards the real time; the opening is replayed in full.
    expect(restarted.seconds(0)).toBeCloseTo(36_005 - 3600, 6)
    expect(restarted.seconds(INTRO_DURATION)).toBeCloseTo(36_005 + INTRO_DURATION, 6)
    const plain = new SolarClock(36_000, false, 1000)
    expect(plain.restartIntro(6000)).toBe(plain)
    const frozen = new SolarClock(36_000, true, 1000, 1, 3600)
    expect(frozen.introGap).toBe(0)
    expect(frozen.seconds(0)).toBe(36_000)
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
  it('keeps both golden-hour discs and the night moon in front of the camera', () => {
    const morning = sampleLighting(6.5 * 3600)
    expect(morning.sunDirection.z).toBeLessThan(0)
    expect(morning.sunDirection.x).toBeGreaterThan(0)
    const evening = sampleLighting(17.5 * 3600)
    expect(evening.sunDirection.z).toBeLessThan(0)
    expect(evening.sunDirection.x).toBeLessThan(0)
    for (const hour of [21, 23, 0, 1]) {
      const moon = sampleLighting(hour * 3600).moonDirection
      expect(moon.z).toBeLessThan(0.2)
      expect(moon.y).toBeGreaterThan(0.15)
      expect(moon.y).toBeLessThan(0.6)
    }
  })
  it('crosses the frame with the moon over the night, right to left, without jumps', () => {
    let previous = sampleLighting(18 * 3600).moonDirection
    expect(azimuth(previous)).toBeCloseTo(MOON_SWEEP, 6)
    expect(azimuth(sampleLighting(6 * 3600 - 1).moonDirection)).toBeCloseTo(-MOON_SWEEP, 3)
    expect(sampleLighting(0).moonDirection.y).toBeGreaterThan(0.33)
    for (let seconds = 18 * 3600 + 60; seconds < 30 * 3600; seconds += 60) {
      const moon = sampleLighting(seconds % 86_400).moonDirection
      expect(moon.length()).toBeCloseTo(1, 6)
      expect(moon.z).toBeLessThan(0)
      expect(moon.y).toBeGreaterThanOrEqual(0.08 - 1e-9)
      expect(Math.abs(azimuth(moon))).toBeLessThanOrEqual(MOON_SWEEP + 1e-9)
      expect(moon.angleTo(previous)).toBeLessThan(0.01)
      previous = moon
    }
    // Through the day it returns unseen along the same arc, so sunset and sunrise join.
    expect(moonPath(0).distanceTo(sampleLighting(18 * 3600).moonDirection)).toBeLessThan(1e-9)
    expect(moonPath(1).distanceTo(sampleLighting(6 * 3600).moonDirection)).toBeLessThan(1e-9)
  })
  it('keeps late-September sun up at 18:26 instead of forcing night at 18:00', () => {
    const paris = { sunrise: 27_720, sunset: 71_040 }
    const evening = sampleLighting(18 * 3600 + 26 * 60, 0, 'clear', paris)
    expect(evening.sunDirection.y).toBeGreaterThan(0)
    expect(evening.daylight).toBeGreaterThan(0)
    expect(evening.localLightStrength).toBe(0)
    expect(sampleLighting(18 * 3600 + 26 * 60).sunDirection.y).toBeLessThan(0)
    expect(sampleLighting(27_720, 0, 'clear', paris).sunDirection.y).toBeCloseTo(0)
    expect(sampleLighting(71_040, 0, 'clear', paris).sunDirection.y).toBeCloseTo(0)
    expect(sampleLighting(0, 0, 'clear', paris).sunIntensity).toBe(0)
  })
  it('stays continuous through custom sunrise, sunset and midnight', () => {
    const solar = { sunrise: 27_720, sunset: 71_040 }
    for (const boundary of [0, 27_720, 71_040, 86400]) {
      const before = sampleLighting(boundary, -0.001, 'clear', solar)
      const after = sampleLighting(boundary, 0.001, 'clear', solar)
      expect(before.sunDirection.distanceTo(after.sunDirection)).toBeLessThan(0.00001)
      expect(Math.abs(before.sunIntensity - after.sunIntensity)).toBeLessThan(0.00001)
      expect(before.localLightStrength).toBeCloseTo(after.localLightStrength, 3)
    }
  })
  it('falls back to 06:00–18:00 for degenerate solar endpoints', () => {
    for (const solar of [
      { sunrise: 64_800, sunset: 21_600 },
      { sunrise: 0, sunset: 0 },
      { sunrise: 0, sunset: 86_400 },
    ]) {
      expect(sampleLighting(12 * 3600, 0, 'clear', solar).sunDirection.y).toBeCloseTo(
        sampleLighting(12 * 3600).sunDirection.y,
      )
      expect(sampleLighting(0, 0, 'clear', solar).sunIntensity).toBe(0)
    }
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
    for (const weather of ['clear', 'partly-cloudy', 'cloudy', 'overcast'] as const) {
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
    for (const weather of ['clear', 'partly-cloudy', 'cloudy', 'overcast'] as const) {
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
      expect(sampleLighting(5.25 * 3600, 0, weather).pointerLightStrength).toBeCloseTo(
        required(dusk[2]),
      )
    }
  })
  it('veils low sun under cloud cover and burns off as it climbs', () => {
    expect(mistFactor(0.05, 0.65)).toBeGreaterThan(0.2)
    expect(mistFactor(0.05, 1)).toBe(0)
    expect(mistFactor(0.5, 0.65)).toBe(0)
    expect(mistFactor(0.05, 0.65)).toBeGreaterThan(mistFactor(0.05, 0.9))
  })
  it('exposes the weather diffusion factor for sky and water grading', () => {
    expect(sampleLighting(12 * 3600, 0, 'clear').weatherDiffuse).toBe(WEATHER.clear.diffuse)
    expect(sampleLighting(12 * 3600, 0, 'overcast').weatherDiffuse).toBe(WEATHER.overcast.diffuse)
  })
  it('dims and greys water scatter under cloud cover', () => {
    const clear = sampleLighting(12 * 3600, 0, 'clear').waterScatter
    const overcast = sampleLighting(12 * 3600, 0, 'overcast').waterScatter
    expect(overcast.g + overcast.b).toBeLessThan(clear.g + clear.b)
    expect(overcast.g / overcast.r).toBeLessThan(clear.g / clear.r)
    expect(overcast.g / overcast.r).toBeLessThan(2)
  })
  it('grades water scatter a dim green-teal by day and near black by night', () => {
    const noon = sampleLighting(12 * 3600).waterScatter
    // Clear lake water absorbs red: what scatters back is green-teal, and dim, so the water
    // mirrors the sky instead of glowing turquoise.
    expect(noon.g).toBeGreaterThan(noon.r * 2)
    expect(noon.g).toBeGreaterThan(noon.b)
    expect(noon.r + noon.g + noon.b).toBeLessThan(0.1)
    const midnight = sampleLighting(0).waterScatter
    expect(midnight.r + midnight.g + midnight.b).toBeLessThan(0.01)
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
    expect(WEATHER.clear.density).toBe(0)
    const partly = createCloudBodies(9182)
    expect(createCloudBodies(9182)).toEqual(partly)
    const overcast = createCloudBodies(9182, 'overcast')
    expect(overcast.uCloudDensity.value).not.toBe(partly.uCloudDensity.value)
    expect(WEATHER.overcast.coverage).toBeGreaterThan(WEATHER['partly-cloudy'].coverage)
    expect(required(overcast.uCloudRadii.value[0]).x).toBeGreaterThan(
      required(partly.uCloudRadii.value[0]).x,
    )
  })
})
