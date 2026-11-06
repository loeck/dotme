import { describe, expect, it } from 'vitest'

import { SHOCK, WaterShockwave, shockCharge, shockImpulse } from './water-shockwave'

describe('water shockwave', () => {
  it('charges only after a still hold, easing up to full', () => {
    expect(shockCharge(0)).toBe(0)
    expect(shockCharge(SHOCK.hold)).toBe(0)
    expect(shockCharge(SHOCK.hold + SHOCK.fill / 2)).toBeCloseTo(0.5, 9)
    expect(shockCharge(SHOCK.hold + SHOCK.fill)).toBe(1)
    expect(shockCharge(60)).toBe(1)
    expect(shockCharge(Number.NaN)).toBe(0)
  })

  it('sends a wider, stronger wave for a fuller charge, within the lake solver limits', () => {
    const weak = shockImpulse(0.2),
      full = shockImpulse(1)
    expect(full.radius).toBeGreaterThan(weak.radius)
    expect(full.velocity).toBeLessThan(weak.velocity)
    expect(full.radius).toBeLessThanOrEqual(3)
    expect(full.velocity).toBeGreaterThanOrEqual(-0.65)
  })

  it('releases a wave from a long still press, nothing from a tap or a drag', () => {
    const wave = new WaterShockwave(0)
    wave.start(2, -5, 400, 600, 10)
    expect(wave.release(10.2)).toBeNull()
    wave.start(2, -5, 400, 600, 20)
    wave.move(405, 603)
    wave.update(20 + SHOCK.hold + 0.5)
    expect(wave.mesh.visible).toBe(true)
    const released = wave.release(20 + SHOCK.hold + SHOCK.fill)
    expect(released).toEqual({ x: 2, z: -5, charge: 1 })
    // The released ring runs out and fades, then hides.
    wave.update(20 + SHOCK.hold + SHOCK.fill + SHOCK.burst / 2)
    expect(wave.mesh.visible).toBe(true)
    wave.update(20 + SHOCK.hold + SHOCK.fill + SHOCK.burst + 0.01)
    expect(wave.mesh.visible).toBe(false)
    wave.start(2, -5, 400, 600, 40)
    wave.move(400, 600 + SHOCK.slop + 1)
    expect(wave.charge(45)).toBe(0)
    expect(wave.release(45)).toBeNull()
    wave.dispose()
  })
})
