import { describe, expect, it } from 'vitest'

import { LAKE_BOUNDS, createLakeBed, lakeIndex } from './lake-bed'
import {
  WaterClock,
  WATER_STEP,
  WAVE_SPEED,
  MAX_WATER_STEPS,
  createWaterMask,
} from './water-simulation'

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

  it('anchors shore contact to rock faces while excluding trees and submerged stones', () => {
    const bed = createLakeBed(
      [
        { x: 0, z: 0, y: 0.2, size: 2, color: 0 },
        { x: 8, z: 0, y: -2, size: 1, color: 0 },
        { x: 16, z: 0, y: 4, size: 3, color: 0 },
      ],
      19,
      false,
      2,
    )
    const n = bed.resolution * 2
    const sample = (x: number, z: number) => {
      const ix = Math.floor(((x - LAKE_BOUNDS.minX) / LAKE_BOUNDS.size) * n)
      const iz = Math.floor(((z - LAKE_BOUNDS.minZ) / LAKE_BOUNDS.size) * n)
      return {
        distance: bed.shore[iz * n + ix]!,
        x: LAKE_BOUNDS.minX + ((ix + 0.5) * LAKE_BOUNDS.size) / n,
      }
    }
    const outside = sample(1.25, 0)
    expect(outside.distance).toBeCloseTo(outside.x - 1, 5)
    expect(sample(0, 0).distance).toBeLessThan(0)
    expect(sample(8, 0).distance).toBe(2)
    expect(sample(16, 0).distance).toBe(2)
    const mask = createWaterMask(bed)
    expect(mask.resolution).toBe(n)
    let mismatches = 0
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++) {
        const wx = LAKE_BOUNDS.minX + ((x + 0.5) * LAKE_BOUNDS.size) / n
        const wz = LAKE_BOUNDS.minZ + ((z + 0.5) * LAKE_BOUNDS.size) / n
        const solid = Math.abs(wx) <= 1 && Math.abs(wz) <= 1
        if (mask.water[z * n + x] !== (solid ? 0 : 255)) mismatches++
      }
    expect(mismatches).toBe(0)
  })
})
