import { expect, it } from 'vitest'

import { midiFrequency, skipNote } from './skip-notes'

const midi = (frequency: number) => Math.round(69 + 12 * Math.log2(frequency / 440))

it('climbs the major pentatonic of the day or night piece and sinks on its low root', () => {
  // C major pentatonic by day, from C5.
  expect([0, 1, 2, 3, 4, 5].map((i) => midi(skipNote(i, false, 1)))).toEqual([
    72, 74, 76, 79, 81, 84,
  ])
  expect(midi(skipNote(3, true, 1))).toBe(60)
  // F major pentatonic at night, from F4.
  expect([0, 1, 2, 3, 4].map((i) => midi(skipNote(i, false, 0)))).toEqual([65, 67, 69, 72, 74])
  expect(midi(skipNote(0, true, 0.2))).toBe(53)
  // No note leaves the two scales' pitch classes, however long the run.
  const allowed = new Set([0, 2, 4, 5, 7, 9])
  for (let i = 0; i < 20; i++)
    for (const daylight of [0, 1])
      expect(allowed.has(midi(skipNote(i, false, daylight)) % 12)).toBe(true)
  expect(midiFrequency(69)).toBe(440)
})
