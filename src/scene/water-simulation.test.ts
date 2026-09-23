import { describe, expect, it } from 'vitest'

import { LAKE_BOUNDS, createLakeBed, lakeIndex } from './lake-bed'
import { WaterClock, WATER_STEP, WAVE_SPEED, MAX_WATER_STEPS } from './water-simulation'

describe('lake field', () => {
  it('uses stable fixed steps at 30, 60 and 144 Hz, and caps catch-up', () => {
    for (const hz of [30, 60, 144]) {
      const clock = new WaterClock()
      let steps = 0
      for (let frame = 0; frame < hz * 4; frame++) steps += clock.advance(1 / hz)
      expect(steps).toBe(240)
      expect(clock.advance(60)).toBe(MAX_WATER_STEPS)
      clock.reset()
      expect(clock.advance(WATER_STEP / 2)).toBe(0)
    }
    for (const resolution of [512, 1024])
      expect((WAVE_SPEED * WATER_STEP) / (LAKE_BOUNDS.size / resolution)).toBeLessThan(Math.SQRT1_2)
  })

  it('joins deterministic submerged relief to solid banks and masks isolated stones', () => {
    const voxels = [
      { x: 0, y: 0.2, z: 0, size: 2, color: 0 },
      { x: 5, y: 0, z: 0, size: 0.3, color: 0 },
    ]
    const a = createLakeBed(voxels, 19, false),
      b = createLakeBed(voxels, 19, false)
    expect(a.depth).toEqual(b.depth)
    expect(a.stones).toEqual(b.stones)
    expect(a.water[lakeIndex(a, 0, 0)]).toBe(0)
    expect(a.water[lakeIndex(a, 5, 0)]).toBe(0)
    expect(a.water[lakeIndex(a, 3, 0)]).toBe(255)
    expect(a.depth[lakeIndex(a, 1.5, 0)]).toBeLessThan(a.depth[lakeIndex(a, 12, 0)]!)
    expect(a.stones.every((stone) => stone.y + stone.size * 0.325 < -0.035)).toBe(true)
    expect(createLakeBed(voxels, 20, false).depth).not.toEqual(a.depth)
    expect(lakeIndex(a, -200, 0)).toBe(-1)
  })
})
