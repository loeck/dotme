import { describe, expect, it } from 'vitest'

import {
  createRippleMask,
  RIPPLE_DOMAIN,
  RIPPLE_SPEED,
  RIPPLE_STEP,
  RippleClock,
  RippleStroke,
} from './water-ripples'

describe('water ripple simulation', () => {
  it('advances the same simulation time at different display refresh rates', () => {
    for (const fps of [30, 60, 120, 144]) {
      const clock = new RippleClock()
      let steps = 0
      for (let frame = 0; frame < fps * 3; frame += 1) steps += clock.advance(1 / fps)
      expect(steps).toBe(360)
    }
  })

  it('bounds catch-up after a stall and preserves fractional steps', () => {
    const clock = new RippleClock()
    expect(clock.advance(0.001)).toBe(0)
    expect(clock.advance(RIPPLE_STEP - 0.001)).toBe(1)
    expect(clock.advance(10)).toBe(6)
    expect(clock.advance(0)).toBe(0)
    expect(clock.advance(-1)).toBe(0)
  })

  it('keeps the wave speed below the explicit solver stability limit at both resolutions', () => {
    for (const resolution of [384, 512]) {
      const courant = (RIPPLE_SPEED * RIPPLE_STEP) / (RIPPLE_DOMAIN.size / resolution)
      expect(courant).toBeLessThan(1 / Math.sqrt(2))
    }
  })

  it('marks terrain as solid while preserving open water and submerged rocks', () => {
    const resolution = 160
    const voxel = { x: 0, y: 0.3, z: 0, size: 2, color: 0 }
    const mask = createRippleMask(
      [voxel, { ...voxel, x: 10, y: -5 }, { ...voxel, x: -1000 }],
      resolution,
    )
    const cell = (x: number, z: number) =>
      mask[(z - RIPPLE_DOMAIN.z) * resolution + x - RIPPLE_DOMAIN.x]
    expect(cell(0, 0)).toBe(0)
    expect(cell(1, 1)).toBe(0)
    expect(cell(10, 0)).toBe(255)
    expect(cell(5, 5)).toBe(255)
    expect(mask.filter((value) => value === 0)).toHaveLength(9)
  })
})

describe('continuous water strokes', () => {
  it('keeps long movements in depth connected without creating impacts', () => {
    const stroke = new RippleStroke()
    stroke.contact(2, -80, false)
    stroke.beginFrame()
    stroke.advance(1)
    expect(stroke.brush.w).toBe(0)
    stroke.contact(2, -10, false)
    stroke.beginFrame()
    stroke.advance(0.5)
    expect(stroke.segment.toArray()).toEqual([2, -80, 2, -45])
    expect(stroke.brush.w).toBe(0)
    stroke.advance(1)
    expect(stroke.segment.toArray()).toEqual([2, -45, 2, -10])
    expect(stroke.brush.w).toBe(0)
  })

  it('preserves continuity after pausing the mouse and emits no stationary stroke', () => {
    const stroke = new RippleStroke()
    stroke.contact(0, 0, false)
    for (let step = 0; step < 120; step += 1) {
      stroke.beginFrame()
      stroke.advance(1)
      expect(stroke.segment.toArray()).toEqual([0, 0, 0, 0])
      expect(stroke.brush.w).toBe(0)
    }
    stroke.contact(0, 4, false)
    stroke.beginFrame()
    stroke.advance(1)
    expect(stroke.segment.toArray()).toEqual([0, 0, 0, 4])
    expect(stroke.brush.w).toBe(0)
  })

  it('disconnects on exit and emits an impact only once for an explicit tap', () => {
    const stroke = new RippleStroke()
    stroke.contact(0, 0, false)
    stroke.endContact()
    stroke.contact(20, 10, false)
    stroke.beginFrame()
    stroke.advance(1)
    expect(stroke.segment.toArray()).toEqual([20, 10, 20, 10])
    expect(stroke.brush.w).toBe(0)
    stroke.contact(20, 10, true, true)
    stroke.endContact() // A quick touch can end before the next simulation step.
    stroke.beginFrame()
    stroke.advance(0.5)
    expect(stroke.brush.z).toBe(1)
    expect(stroke.brush.w).toBe(1)
    stroke.advance(1)
    expect(stroke.brush.z).toBe(0)
    expect(stroke.brush.w).toBe(0)
  })
})
