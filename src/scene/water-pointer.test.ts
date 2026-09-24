import { describe, expect, it } from 'vitest'

import { waterStroke } from './water-pointer'

const budget = (events: number) => {
  const stroke = waterStroke(60 / events, 0.3 / events, 3 / events, false)
  return stroke.velocity * stroke.samples * events
}

describe('pointer wake budget', () => {
  it('keeps the same energy when perspective stretches a vertical stroke', () => {
    const across = waterStroke(40, 0.1, 1, false)
    const vertical = waterStroke(40, 0.1, 12, false)
    expect(vertical.samples).toBeGreaterThan(across.samples)
    expect(vertical.velocity * vertical.samples).toBeCloseTo(across.velocity * across.samples)
  })

  it('is independent of event frequency for a constant-speed gesture', () => {
    expect(budget(6)).toBeCloseTo(budget(18))
    expect(budget(18)).toBeCloseTo(budget(36))
  })

  it('leaves stationary water alone and bounds fast input while retaining a stronger drag', () => {
    expect(waterStroke(0, 1, 0, false).velocity).toBeCloseTo(0)
    const hover = waterStroke(30, 0.05, 4, false)
    const drag = waterStroke(30, 0.05, 4, true)
    expect(Math.abs(drag.velocity * drag.samples)).toBeGreaterThan(
      Math.abs(hover.velocity * hover.samples) * 3,
    )
    const jump = waterStroke(4000, 0, 100, true)
    expect(jump.samples).toBeLessThanOrEqual(48)
    expect(Math.abs(jump.velocity * jump.samples)).toBeLessThanOrEqual(1.12)
  })
})
