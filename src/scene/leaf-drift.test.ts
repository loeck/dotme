import { Scene } from 'three'
import { describe, expect, it } from 'vitest'

import { LakeLeaves } from './lake-leaves'
import { LeafDrift, leafClearance } from './leaf-drift'
import { createVoxelWorld } from './voxel-world'
import { WindModel } from './wind'

const wind = new WindModel(42).sample(0)
describe('floating leaves', () => {
  it('keeps fixed seeded populations clear of banks and rocks through wind and strong gestures', () => {
    for (const mobile of [false, true])
      for (const seed of [0, 12, 42, 9182]) {
        const bed = createVoxelWorld(seed, mobile).lakeBed
        const drift = new LeafDrift(bed, seed, mobile)
        expect(drift.leaves).toHaveLength(mobile ? 6 : 12)
        expect(drift.leaves).toEqual(new LeafDrift(bed, seed, mobile).leaves)
        let minimumMargin = Infinity
        for (let i = 0; i < 1800; i++) {
          if (i % 60 === 0)
            for (const leaf of drift.leaves) drift.push(leaf.x - 1, leaf.z, leaf.x + 1, leaf.z, 4)
          drift.advance(1 / 30, wind)
          if (i % 60 === 0)
            for (const leaf of drift.leaves)
              minimumMargin = Math.min(
                minimumMargin,
                leafClearance(bed, leaf.x, leaf.z) - leaf.size - 0.15,
              )
        }
        expect(minimumMargin).toBeGreaterThanOrEqual(0)
      }
  })
  it('has equivalent fixed-step motion at 30/60/120Hz, bounded catch-up and frozen poses', () => {
    const bed = createVoxelWorld(42, false).lakeBed
    const runs = [30, 60, 120].map((fps) => {
      const drift = new LeafDrift(bed, 42, false)
      for (let i = 0; i < fps * 10; i++) drift.advance(1 / fps, wind)
      return drift.leaves
    })
    expect(runs[0]).toEqual(runs[1])
    expect(runs[1]).toEqual(runs[2])
    const drift = new LeafDrift(bed, 42, false, true),
      before = structuredClone(drift.leaves)
    drift.push(-20, 0, 20, 0, 5)
    drift.advance(100, wind)
    expect(drift.leaves).toEqual(before)
    const moving = new LeafDrift(bed, 42, false),
      initial = structuredClone(moving.leaves)
    moving.advance(100, wind)
    expect(
      Math.hypot(moving.leaves[0]!.x - initial[0]!.x, moving.leaves[0]!.z - initial[0]!.z),
    ).toBeLessThan(0.02)
  })
  it('reacts only to moving segments and receives but never casts shadows', () => {
    const leaves = new LakeLeaves(
      new Scene(),
      createVoxelWorld(42, false).lakeBed,
      42,
      false,
      false,
    )
    const leaf = leaves.drift.leaves[0]!
    leaves.drift.push(leaf.x, leaf.z, leaf.x, leaf.z, 1)
    expect(leaf.vx).toBe(0)
    expect(leaf.vz).toBe(0)
    leaves.drift.push(leaf.x - 1, leaf.z, leaf.x + 1, leaf.z, 1)
    expect(Math.hypot(leaf.vx, leaf.vz)).toBeGreaterThan(0)
    expect(leaves.mesh.layers.mask).toBe(1)
    expect(leaves.mesh.receiveShadow).toBe(true)
    expect(leaves.mesh.castShadow).toBe(false)
    leaves.dispose()
  })
})
