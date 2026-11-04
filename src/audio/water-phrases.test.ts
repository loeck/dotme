import { expect, it } from 'vitest'

import { loopPhrase, pickPhrase, waterPhrase } from './water-phrases'

it('keeps random passages within the recording and avoids repeated openings', () => {
  for (const previous of [-Infinity, 0, 8, 15, 24, 36])
    for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
      const phrase = waterPhrase(60, previous, () => r)
      expect(phrase.duration).toBeGreaterThanOrEqual(24)
      expect(phrase.duration).toBeLessThanOrEqual(36)
      expect(phrase.offset).toBeGreaterThanOrEqual(0)
      expect(phrase.offset + phrase.duration).toBeLessThanOrEqual(60)
      expect(Math.abs(phrase.offset - previous)).toBeGreaterThanOrEqual(8)
      expect(phrase.fade).toBe(4)
    }
})

it('takes fresh passages of shorter loops and never repeats a call window', () => {
  for (const duration of [17, 21, 23, 24])
    for (const previous of [-Infinity, 0, 3, 6])
      for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
        const phrase = loopPhrase(duration, previous, () => r)
        expect(phrase.duration).toBeGreaterThanOrEqual(duration * 0.5)
        expect(phrase.duration).toBeLessThanOrEqual(duration * 0.85)
        expect(phrase.offset).toBeGreaterThanOrEqual(0)
        expect(phrase.offset + phrase.duration).toBeLessThanOrEqual(duration + 1e-9)
        expect(phrase.fade).toBeLessThanOrEqual(phrase.duration / 4)
        // Consecutive passages of one recording share a fade, so their crossfades line up.
        expect(phrase.fade).toBe(loopPhrase(duration, previous, () => 0.5).fade)
      }
  const calls = ['a', 'b', 'c', 'd']
  for (const previous of [-1, 0, 1, 2, 3, 9])
    for (const r of [0, 0.3, 0.6, 0.999999]) {
      const index = pickPhrase(calls, previous, () => r)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(calls.length)
      expect(index).not.toBe(previous)
    }
  expect(pickPhrase(['only'], 0, () => 0.5)).toBe(0)
})
