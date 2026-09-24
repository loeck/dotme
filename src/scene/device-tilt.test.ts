import { describe, expect, it } from 'vitest'

import { screenLean } from './device-tilt'

describe('screenLean', () => {
  it('is neutral for an upright portrait phone', () => {
    expect(screenLean(90, 0, 0)).toBeCloseTo(0)
  })

  it('leans right when the portrait phone rolls clockwise', () => {
    // Near the Euler lock, a 15° roll of an upright phone reports beta 75° and gamma ±90°.
    const right = screenLean(75, 90, 0)
    const left = screenLean(75, -90, 0)
    expect(screenLean(45, 15, 0)).toBeGreaterThan(0.3)
    expect(right).toBeGreaterThan(0.3)
    expect(left).toBeCloseTo(-(right ?? 0))
  })

  it('saturates beyond the lean range', () => {
    expect(screenLean(45, 60, 0)).toBe(1)
    expect(screenLean(45, -60, 0)).toBe(-1)
  })

  it('ignores a flat phone', () => {
    expect(screenLean(0, 0, 0)).toBeNull()
    expect(screenLean(5, 5, 90)).toBeNull()
  })

  it('follows the screen axis in landscape', () => {
    // Landscape-primary upright: gravity runs along the device x axis.
    expect(screenLean(0, -90, 90)).toBeCloseTo(0)
    expect(screenLean(15, -80, 90)).toBeGreaterThan(0.3)
    expect(screenLean(-15, -80, 90)).toBeLessThan(-0.3)
    expect(screenLean(0, 90, 270)).toBeCloseTo(0)
    expect(screenLean(15, 80, 270)).toBeLessThan(-0.3)
  })

  it('keeps a dead zone around neutral', () => {
    expect(screenLean(90, 1, 0)).toBe(0)
  })
})
