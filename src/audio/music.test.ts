import { expect, it } from 'vitest'

import { musicGap, musicMood } from './music'

const at = (daylight: number, rainIntensity = 0) => ({
  daylight,
  rainIntensity,
  solarHour: 12,
  windSpeed: 0,
})

it('chooses the day piece only in dry daylight and leaves minutes of silence between pieces', () => {
  expect(musicMood(at(1))).toBe('day')
  expect(musicMood(at(0.2))).toBe('night')
  expect(musicMood(at(1, 0.8))).toBe('night')
  expect(musicMood(at(NaN, NaN))).toBe('night')
  expect(musicGap(at(1), () => 0)).toBe(150)
  expect(musicGap(at(1), () => 0.999)).toBeLessThan(300)
  expect(musicGap(at(1, 1), () => 0)).toBe(225)
})
