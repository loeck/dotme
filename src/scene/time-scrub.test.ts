import { describe, expect, it } from 'vitest'

import { SCRUB, TimeScrub, wheelPixels } from './time-scrub'

const run = (scrub: TimeScrub, from: number, seconds: number, step = 1 / 60) => {
  let now = from
  for (; now < from + seconds; now += step) scrub.update(step, now)
  return now
}

describe('time scrubbing', () => {
  it('reads wheel travel in pixels from any delta mode', () => {
    expect(wheelPixels(100, 0)).toBe(100)
    expect(wheelPixels(3, 1)).toBe(3 * SCRUB.linePixels)
    expect(wheelPixels(-1, 2)).toBe(-SCRUB.pagePixels)
    expect(wheelPixels(Number.NaN, 0)).toBe(0)
  })

  it('time-lapses toward the scrubbed hour instead of jumping', () => {
    const scrub = new TimeScrub()
    scrub.scrub(3600, 0)
    scrub.update(1 / 60, 1 / 60)
    expect(scrub.offset).toBeGreaterThan(0)
    expect(scrub.offset).toBeLessThan(600)
    run(scrub, 0.1, 2)
    expect(scrub.offset).toBeCloseTo(3600, -1)
    expect(scrub.active).toBe(true)
  })

  it('holds the scrubbed hour, then drifts back to the real one', () => {
    const scrub = new TimeScrub()
    scrub.scrub(5 * 3600, 0)
    const settled = run(scrub, 0, SCRUB.hold - 0.5)
    expect(scrub.offset).toBeCloseTo(5 * 3600, -1)
    run(scrub, settled, 20)
    expect(scrub.offset).toBe(0)
    expect(scrub.active).toBe(false)
  })

  it('settles on the nearest whole day, so a long scrub never rewinds through the day', () => {
    const scrub = new TimeScrub()
    scrub.scrub(22 * 3600, 0)
    const settled = run(scrub, 0, 3)
    let lowest = Infinity
    for (let now = settled; now < settled + 30; now += 1 / 60) {
      scrub.update(1 / 60, now)
      if (scrub.active) lowest = Math.min(lowest, scrub.offset)
    }
    // It runs forward to +24 h (the same local hour) instead of back through 22 hours.
    expect(lowest).toBeGreaterThan(21 * 3600)
    expect(scrub.active).toBe(false)
  })

  it('ignores empty or invalid gestures and resets', () => {
    const scrub = new TimeScrub()
    scrub.scrub(0, 0)
    scrub.scrub(Number.POSITIVE_INFINITY, 0)
    expect(scrub.active).toBe(false)
    scrub.scrub(1200, 0)
    scrub.reset()
    expect(scrub.active).toBe(false)
    expect(scrub.offset).toBe(0)
  })
})
