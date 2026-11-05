import { describe, expect, it } from 'vitest'

import { required } from '../invariant'
import { WATER_LEVEL } from './lake-bed'
import { createLakeWorld } from './lake-world'
import { prepareGorge } from './terrain-gorge'

describe('waterfall gorge', () => {
  it.each([false, true].flatMap((mobile) => [1, 12, 42, 9182].map((seed) => ({ mobile, seed }))))(
    'wraps the block behind the fall and keeps clear of the sheet (mobile=$mobile, seed=$seed)',
    ({ mobile, seed }) => {
      const world = createLakeWorld(seed, mobile)
      const fall = required(world.waterfall)
      const gorge = prepareGorge(world.field, fall)
      expect(gorge.indices.length / 3).toBeGreaterThan(500)
      expect(gorge.indices.length / 3).toBeLessThan(12_000)
      const [nx, nz] = fall.direction
      let blocking = 0,
        outward = 0
      for (let i = 0; i < gorge.positions.length; i += 3) {
        const x = required(gorge.positions[i]) - fall.x,
          y = required(gorge.positions[i + 1]),
          z = required(gorge.positions[i + 2]) - fall.z
        const along = x * nx + z * nz
        const across = x * nz - z * nx
        // The sheet's front at this height, ballistic to the landing 0.8 m out.
        const sheet = 0.8 * Math.sqrt(Math.max(0, (fall.top - y) / (fall.top - WATER_LEVEL)))
        if (Math.abs(across) < fall.width / 2 && along > sheet - 0.05) blocking++
        // Normals look away from the block.
        const nxv = required(gorge.normals[i]),
          nzv = required(gorge.normals[i + 2])
        if (nxv * (x + nx * 0.7) + nzv * (z + nz * 0.7) > 0) outward++
      }
      expect(blocking).toBe(0)
      expect(outward / (gorge.positions.length / 3)).toBeGreaterThan(0.8)
    },
  )
})
