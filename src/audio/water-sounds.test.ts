import { expect, it } from 'vitest'

import { WaterSoundPicker } from './water-sounds'
import type { WaterSoundWindow } from './water-sounds'

const takes: WaterSoundWindow[] = [
  { kind: 'burst', offset: 0, duration: 1.5 },
  { kind: 'burst', offset: 2, duration: 1.5 },
  { kind: 'drop', offset: 4, duration: 0.3 },
  { kind: 'drop', offset: 5, duration: 0.3 },
  { kind: 'wave', offset: 6, duration: 1 },
]

it('varies takes, keeps levels and pans bounded and thins drops to a patter', () => {
  let r = 0
  const picker = new WaterSoundPicker(takes, () => (r = (r + 0.37) % 1))
  const bursts = [0, 1, 2, 3].map((i) => picker.pick({ kind: 'burst', intensity: 2, pan: -3 }, i))
  for (let i = 1; i < bursts.length; i++) expect(bursts[i]?.offset).not.toBe(bursts[i - 1]?.offset)
  for (const take of bursts) {
    expect(take?.level).toBe(1)
    expect(take?.pan).toBe(-1)
    expect(take?.rate).toBeGreaterThanOrEqual(0.92)
    expect(take?.rate).toBeLessThanOrEqual(1.08)
  }
  expect(picker.pick({ kind: 'wave', intensity: 0.01, pan: 0 }, 10)).toBeUndefined()
  expect(picker.pick({ kind: 'wave', intensity: NaN, pan: NaN }, 10)).toBeUndefined()
  let drops = 0
  for (let t = 20; t < 21; t += 0.01)
    if (picker.pick({ kind: 'drop', intensity: 0.5, pan: 0 }, t)) drops++
  expect(drops).toBeLessThanOrEqual(8)
  expect(drops).toBeGreaterThan(3)
  expect(new WaterSoundPicker([]).pick({ kind: 'burst', intensity: 1, pan: 0 }, 0)).toBeUndefined()
})
