import { describe, expect, it } from 'vitest'

import { createLakeBed, LAKE_BOUNDS } from './lake-bed'
import type { Voxel } from './voxel-world'

describe('lake shore distance', () => {
  it('preserves interior, edge and corner distances across overlapping terrain footprints', () => {
    const voxels: Voxel[] = [
      { x: 0, y: 0, z: 0, size: 1.5, color: 0 },
      { x: 0.65, y: 0.2, z: 0.25, size: 0.5, color: 0 },
      { x: -0.35, y: 1, z: -0.2, size: 0.5, color: 0 },
      { x: 0, y: 1.5, z: 0, size: 1.5, color: 0 },
    ]
    const bed = createLakeBed(voxels, 42, true)
    const resolution = bed.resolution * 2
    const cell = LAKE_BOUNDS.size / resolution
    let inside = 0,
      outside = 0
    for (let z = 0; z < resolution; z++) {
      const worldZ = LAKE_BOUNDS.minZ + (z + 0.5) * cell
      if (worldZ < -0.8 || worldZ > 0.9) continue
      for (let x = 0; x < resolution; x++) {
        const worldX = LAKE_BOUNDS.minX + (x + 0.5) * cell
        if (worldX < -0.8 || worldX > 0.9) continue
        let expected = 2
        for (const voxel of voxels) {
          const half = voxel.size / 2
          const dx = Math.abs(worldX - voxel.x) - half
          const dz = Math.abs(worldZ - voxel.z) - half
          const distance =
            dx <= 0 && dz <= 0 ? Math.max(dx, dz) : Math.hypot(Math.max(0, dx), Math.max(0, dz))
          expected = Math.fround(Math.min(expected, distance))
        }
        expect(bed.shore[z * resolution + x]).toBe(expected)
        if (expected < 0) inside++
        else outside++
      }
    }
    expect(inside).toBeGreaterThan(0)
    expect(outside).toBeGreaterThan(0)
  })
})
