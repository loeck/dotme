import { describe, expect, it } from 'vitest'

import { required } from '../invariant'
import { LAKE_BOUNDS, createLakeBed, lakeIndex } from './lake-bed'
import { prepareWaterMask } from './lake-geometry-data'
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
    expect(a.depth[lakeIndex(a, 1.5, 0)]).toBeLessThan(required(a.depth[lakeIndex(a, 12, 0)]))
    expect(a.stones.every((stone) => stone.y + stone.size * 0.325 < -0.035)).toBe(true)
    expect(createLakeBed(voxels, 20, false).depth).not.toEqual(a.depth)
    expect(lakeIndex(a, -200, 0)).toBe(-1)
  })

  it('keeps dune relief bounded, positive and out of the shallows', () => {
    const bed = createLakeBed([{ x: 0, y: 0.2, z: 0, size: 2, color: 0 }], 19, false)
    let rippled = 0
    for (let i = 0; i < bed.depth.length; i++) {
      const depth = required(bed.depth[i])
      expect(depth).toBeGreaterThanOrEqual(0)
      expect(depth).toBeLessThanOrEqual(7.5)
      if (required(bed.water[i]) && depth > 1.3 && depth < 3.8) rippled++
    }
    expect(rippled).toBeGreaterThan(0)
    const shore = lakeIndex(bed, 2, 0)
    expect(bed.water[shore]).toBe(255)
    expect(required(bed.depth[shore])).toBeLessThan(0.6)
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
        distance: required(bed.shore[iz * n + ix]),
        x: LAKE_BOUNDS.minX + ((ix + 0.5) * LAKE_BOUNDS.size) / n,
      }
    }
    const outside = sample(1.25, 0)
    expect(outside.distance).toBeCloseTo(outside.x - 1, 5)
    expect(sample(0, 0).distance).toBeLessThan(0)
    expect(sample(8, 0).distance).toBe(2)
    expect(sample(16, 0).distance).toBe(2)
    const mask = prepareWaterMask(bed)
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
