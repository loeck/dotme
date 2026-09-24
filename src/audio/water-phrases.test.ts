import { expect, it } from 'vitest'

import { waterPhrase } from './water-phrases'

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
