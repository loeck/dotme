import { expect, it } from 'vitest'

import { CURSOR_LAG_MS, CursorMotion } from './cursor-motion'

const matrix = (value: string) => {
  const match = /^matrix\((.+)\)$/.exec(value)
  if (!match?.[1]) throw new Error(`Not a matrix: ${value}`)
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = match[1].split(',').map(Number)
  return { a, b, c, d, e, f }
}

/** Moves at `speed` px/ms along +x for `duration` ms, one frame every `interval` ms. */
function sweep(speed: number, interval: number, duration = 120) {
  const motion = new CursorMotion()
  motion.moveTo(0, 0)
  for (let time = interval; time <= duration + 1e-9; time += interval) {
    // Several events may land between frames; only the latest position matters.
    motion.moveTo(speed * (time - interval / 2), 0)
    motion.moveTo(speed * time, 0)
    motion.step(interval)
  }
  return motion
}

it('starts at rest and settles back to an exact identity', () => {
  const motion = new CursorMotion()
  motion.moveTo(400, 300)
  expect(motion.strain(3)).toBe('none')
  expect(motion.step(16)).toBe(false)
  motion.moveTo(430, 300)
  expect(motion.strain(3)).not.toBe('none')
  let frames = 0
  while (motion.step(16)) frames++
  // About 10 time constants from a 30 px jump to the rest threshold.
  expect(frames * 16).toBeLessThan(CURSOR_LAG_MS * 12)
  expect(motion.strain(3)).toBe('none')
  expect(motion.lag(5)).toBe('0 0')
})

const stretch = (speed: number) => matrix(sweep(speed, 4).strain(3)).a
/** Long enough for the start-up transient to vanish at every frame rate. */
const steady = (interval: number) => sweep(1, interval, Math.round(480 / interval) * interval)

it('grows with speed instead of saturating at a crawl', () => {
  const crawl = stretch(0.1)
  const walk = stretch(0.6)
  const flick = stretch(4)
  expect(crawl).toBeGreaterThan(1.05)
  expect(crawl).toBeLessThan(1.25)
  expect(walk).toBeGreaterThan(crawl + 0.3)
  expect(flick).toBeGreaterThan(walk + 0.2)
  expect(flick).toBeLessThanOrEqual(2.1)
})

it('preserves area and keeps the leading edge on the hit point', () => {
  const { a, b, c, d, e, f } = matrix(sweep(2, 8).strain(3))
  expect(a * d - b * c).toBeCloseTo(Math.sqrt(a), 3)
  expect(b).toBe(0)
  expect(c).toBe(0)
  // The ellipse's front edge (local x = +3) stays at +3 px; the tail extends behind.
  expect(a * 3 + e).toBeCloseTo(3, 3)
  expect(e).toBeLessThan(0)
  expect(f).toBe(0)
})

it('gives equal strain for equal speeds at different frame rates', () => {
  const baseline = matrix(steady(16).strain(3))
  expect(baseline.a).toBeGreaterThan(1.5)
  for (const interval of [1000 / 144, 8, 4, 1]) {
    const strain = matrix(steady(interval).strain(3))
    expect(strain.a).toBeCloseTo(baseline.a, 3)
    expect(strain.e).toBeCloseTo(baseline.e, 3)
  }
})

it('turns smoothly when the pointer reverses', () => {
  const motion = sweep(1.5, 4)
  const angles: number[] = []
  for (let i = 0; i < 40; i++) {
    motion.moveTo(motion.x, motion.y + 6)
    motion.step(4)
    const { a, b, d } = matrix(motion.strain(3))
    angles.push(Math.atan2(2 * b, a - d) / 2)
  }
  for (let i = 1; i < angles.length; i++) {
    expect(Math.abs((angles[i] ?? 0) - (angles[i - 1] ?? 0))).toBeLessThan(0.25)
  }
})

it('bounds the lagging companion', () => {
  const motion = sweep(6, 4)
  const [x = 0, y = 0] = motion
    .lag(5)
    .split(' ')
    .map((value) => Number.parseFloat(value))
  expect(x).toBeLessThan(0)
  expect(x).toBeGreaterThan(-5)
  expect(y).toBe(0)
})

it('restarts at rest after a reset', () => {
  const motion = sweep(3, 4)
  motion.reset()
  motion.moveTo(900, 100)
  expect(motion.strain(3)).toBe('none')
})
