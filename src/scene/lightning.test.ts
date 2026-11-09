import { describe, expect, it } from 'vitest'

import { LIGHTNING, Lightning } from './lightning'
import type { Strike } from './lightning'

const sequence = (seed: number) => {
  let state = seed
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4_294_967_296
  }
}

describe('lightning', () => {
  it('strikes now and then in a storm, never outside one', () => {
    const calm = new Lightning(sequence(1))
    for (let t = 0; t < 120; t += 1 / 30)
      expect(calm.update(t, false, () => expect.unreachable())).toBe(0)
    const storm = new Lightning(sequence(2))
    const strikes: Strike[] = []
    let brightest = 0
    for (let t = 0; t < 600; t += 1 / 60)
      brightest = Math.max(
        brightest,
        storm.update(t, true, (s) => strikes.push(s)),
      )
    // About one strike every fourteen seconds.
    expect(strikes.length).toBeGreaterThan(600 / LIGHTNING.meanGap / 2)
    expect(strikes.length).toBeLessThan((600 / LIGHTNING.meanGap) * 2)
    expect(brightest).toBeGreaterThan(0.2)
    expect(brightest).toBeLessThanOrEqual(1)
    for (const strike of strikes) {
      expect(strike.distance).toBeGreaterThanOrEqual(1000)
      expect(strike.distance).toBeLessThanOrEqual(8000)
      expect(strike.delay).toBeCloseTo(strike.distance / LIGHTNING.soundSpeed, 9)
      expect(Math.abs(strike.pan)).toBeLessThanOrEqual(0.8)
      expect(strike.intensity).toBeGreaterThan(0)
      expect(strike.intensity).toBeLessThanOrEqual(1)
    }
  })

  it('flashes and fades within a fraction of a second', () => {
    const storm = new Lightning(() => 0.5, 0)
    let struck = -1
    for (let t = 0; t < 30; t += 1 / 60) {
      storm.update(t, true, () => (struck = t))
      if (struck >= 0) break
    }
    expect(struck).toBeGreaterThan(0)
    expect(storm.update(struck + 1, true)).toBe(0)
  })

  it('waits at least the shortest gap once a storm starts', () => {
    const storm = new Lightning(() => 0, 0)
    for (let t = 0; t < 50; t += 0.5) storm.update(t, false)
    let first = -1
    for (let t = 50; t < 80; t += 1 / 60) {
      storm.update(t, true, () => (first = t))
      if (first >= 0) break
    }
    expect(first).toBeGreaterThanOrEqual(50 + LIGHTNING.minGap - 0.5)
  })
})

describe('lightning and photosensitivity', () => {
  it('never flashes more than three times in any second', () => {
    const storm = new Lightning(sequence(9))
    const onsets: number[] = []
    let previous = 0,
      rising = false
    const step = 1 / 120
    for (let t = 0; t < 900; t += step) {
      const flash = storm.update(t, true)
      if (flash > previous + 0.02 && !rising) onsets.push(t)
      rising = flash > previous
      previous = flash
    }
    expect(onsets.length).toBeGreaterThan(20)
    for (let i = 3; i < onsets.length; i++)
      expect((onsets[i] ?? 0) - (onsets[i - 3] ?? 0)).toBeGreaterThan(1)
  })
})
