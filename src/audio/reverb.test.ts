import { expect, it } from 'vitest'

import { REVERB_SECONDS, reverbBytes, reverbImpulse } from './reverb'

const rms = (samples: Float32Array, from: number, to: number) => {
  let sum = 0
  for (let i = from; i < to; i++) sum += (samples[i] ?? 0) ** 2
  return Math.sqrt(sum / (to - from))
}

it('builds a small, decorrelated, decaying stereo impulse, the same on every page', () => {
  const rate = 8000
  const [left, right] = reverbImpulse(rate)
  expect(left.length).toBe(REVERB_SECONDS * rate)
  expect(reverbBytes(32_000)).toBe(640_000)
  expect(reverbImpulse(rate)).toEqual([left, right])
  expect(left[0]).toBe(0)
  expect(left).not.toEqual(right)
  const early = rms(left, 100, 2000),
    late = rms(left, 18_000, 20_000)
  expect(late).toBeLessThan(early / 100)
  for (const value of [...left, ...right]) expect(Math.abs(value)).toBeLessThan(1)
})
