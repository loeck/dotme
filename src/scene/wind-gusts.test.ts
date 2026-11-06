import { describe, expect, it } from 'vitest'

import { GUST, WindGusts, gustEnvelope, sweepStrength } from './wind-gusts'

describe('wind gusts', () => {
  it('needs a quick sweep, and grows with its speed', () => {
    expect(sweepStrength(GUST.minSweep - 1)).toBe(0)
    expect(sweepStrength(Number.NaN)).toBe(0)
    expect(sweepStrength(GUST.minSweep)).toBeGreaterThan(0)
    expect(sweepStrength(GUST.fullSweep)).toBeCloseTo(1, 9)
    expect(sweepStrength(10_000)).toBe(1)
  })

  it('runs a band down the sweep that fades over its life', () => {
    // At the start the push sits at the origin, then moves on at the gust speed.
    expect(gustEnvelope(0, 0, 0, 12)).toBeCloseTo(1, 9)
    const t = 1
    const ahead = gustEnvelope(12 * t, 0, t, 12)
    expect(ahead).toBeGreaterThan(gustEnvelope(0, 0, t, 12))
    expect(ahead).toBeGreaterThan(gustEnvelope(12 * t, GUST.width * 2, t, 12))
    expect(ahead).toBeLessThan(1)
    expect(gustEnvelope(12 * GUST.life, 0, GUST.life, 12)).toBe(0)
    expect(gustEnvelope(0, 0, -0.1, 12)).toBe(0)
  })

  it('keeps a few gusts in flight, spaced out, along the sweep direction', () => {
    const gusts = new WindGusts()
    expect(gusts.raise(0, 0, 1, 0, 1, 10)).toBe(true)
    // Too soon after the last one.
    expect(gusts.raise(5, 5, 1, 0, 1, 10.1)).toBe(false)
    expect(gusts.raise(0, 0, 0, 0, 1, 11)).toBe(false)
    // It pushes downwind of its origin as it travels, not upwind.
    expect(gusts.at(GUST.minSpeed, 0, 11)).toBeGreaterThan(gusts.at(-GUST.minSpeed, 0, 11))
    for (let i = 0; i < GUST.slots + 2; i++) gusts.raise(100 + i * 10, 0, 0, 1, 1, 20 + i)
    // A fast sweep's front keeps pace with it, within the bounds.
    const fast = new WindGusts()
    fast.raise(0, 0, 1, 0, 1, 0, 25)
    expect(fast.at(25, 0, 1)).toBeGreaterThan(fast.at(GUST.minSpeed, 0, 1))
    // The first gust has been replaced.
    expect(gusts.at(GUST.minSpeed, 0, 11)).toBe(0)
    gusts.clear()
    expect(gusts.at(100, GUST.minSpeed, 21)).toBe(0)
  })
})
