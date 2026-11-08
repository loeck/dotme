import { describe, expect, it } from 'vitest'

import { AMBIENT_GUST, ambientGust, gustSpell } from './wind-field'

describe('ambient gust field', () => {
  it('stays within 0–1 and has both lulls and squalls', () => {
    let low = Infinity,
      high = -Infinity
    for (let t = 0; t < 600; t += 0.5) {
      const spell = gustSpell(t)
      low = Math.min(low, spell)
      high = Math.max(high, spell)
      const g = ambientGust(t * 0.7, -t * 0.3, t, 1, 0)
      expect(g).toBeGreaterThanOrEqual(0)
      expect(g).toBeLessThanOrEqual(1)
    }
    expect(low).toBe(0)
    expect(high).toBe(1)
  })

  it('rolls its patches downwind', () => {
    // A point riding downwind at the patch speed keeps seeing nearly the same band.
    const x = 10,
      t = 40,
      dt = 0.4
    const riding = Math.abs(
      ambientGust(x + AMBIENT_GUST.speed * dt, 0, t + dt, 1, 0) /
        Math.max(1e-6, ambientGust(x, 0, t, 1, 0)),
    )
    expect(riding).toBeGreaterThan(0.85)
    expect(riding).toBeLessThan(1.15)
  })
})
