import { describe, expect, it } from 'vitest'

import { createVoxelWorld } from './voxel-world'

describe('voxel lake world', () => {
  it('is deterministic and keeps desktop within an instancing budget', () => {
    const first = createVoxelWorld(9182, false)
    const second = createVoxelWorld(9182, false)
    expect(first.voxels).toEqual(second.voxels)
    expect(first.voxels.length).toBeGreaterThan(8_000)
    expect(first.voxels.length).toBeLessThan(70_000)
    expect(first.lamps.length).toBeGreaterThanOrEqual(4)
    expect(
      first.lamps.some((lamp) => lamp.x > -21 && lamp.x < -15 && lamp.z < -18 && lamp.z > -21),
    ).toBe(true)
    expect(
      first.lamps.some((lamp) => lamp.x > 20 && lamp.x < 33 && lamp.z < -28 && lamp.z > -36),
    ).toBe(true)
    expect(first.groups.treeLeaf.count).toBeGreaterThan(0)
    for (const material of ['ground', 'shore', 'rock'] as const) {
      const positions = first.groups[material].positions
      for (let index = 0; index < positions.length; index += 3) {
        const x = positions[index]!
        const z = positions[index + 2]!
        expect(x > 1 && x < 20 && z > -56).toBe(false)
      }
    }
  })

  it('uses a materially lighter mobile world while retaining the lake corridor', () => {
    const desktop = createVoxelWorld(12, false)
    const mobile = createVoxelWorld(12, true)
    expect(mobile.voxels.length).toBeLessThan(desktop.voxels.length)
    expect(mobile.voxels.length).toBeLessThan(22_000)
    expect(mobile.shoreCount).toBeGreaterThan(20)
    expect(mobile.lamps.some((lamp) => lamp.x < -2 && lamp.x > -7)).toBe(true)
    expect(mobile.lamps.some((lamp) => lamp.x > 7 && lamp.x < 15)).toBe(true)
    const trunks = mobile.groups.treeTrunk.positions
    expect(
      Array.from({ length: trunks.length / 3 }, (_, index) => trunks[index * 3]!).some(
        (x) => x > 7 && x < 10,
      ),
    ).toBe(true)
    expect(mobile.suggestedCamera.position).toEqual([0, 2.5, 16])
  })

  it('shapes two left headlands around a deep inlet and holds the right bank farther away', () => {
    for (const seed of [0, 9182]) {
      const world = createVoxelWorld(seed, false)
      const frontEdge = (minX: number, maxX: number) => {
        const depths: number[] = []
        for (let index = 0; index < world.shores.length; index += 3) {
          const x = world.shores[index]!
          if (x >= minX && x < maxX) depths.push(world.shores[index + 2]!)
        }
        return Math.max(...depths)
      }

      expect(frontEdge(-38, -30)).toBeLessThan(-30)
      expect(frontEdge(-38, -30)).toBeLessThan(frontEdge(-51, -42) - 18)
      expect(frontEdge(-38, -30)).toBeLessThan(frontEdge(-22, -16) - 20)
      expect(frontEdge(-13, -9)).toBeLessThan(frontEdge(-22, -16) - 8)
      expect(frontEdge(35, 43)).toBeLessThan(frontEdge(-22, -16) - 10)
    }
  })

  it('raises the outer left bank and the distant right ridge without filling the lake', () => {
    for (const seed of [0, 9182]) {
      const world = createVoxelWorld(seed, false)
      const ridgeHeight = (minX: number, maxX: number, minZ = -45, maxZ = -12) => {
        const heights: number[] = []
        for (const material of ['ground', 'shore', 'rock'] as const) {
          const positions = world.groups[material].positions
          for (let index = 0; index < positions.length; index += 3) {
            const x = positions[index]!
            const z = positions[index + 2]!
            if (x >= minX && x < maxX && z > minZ && z < maxZ) heights.push(positions[index + 1]!)
          }
        }
        heights.sort((a, b) => a - b)
        return heights[Math.floor(heights.length * 0.9)]!
      }

      expect(ridgeHeight(-52, -43)).toBeGreaterThan(ridgeHeight(-22, -14) + 3)
      expect(ridgeHeight(54, 66, -75, -35)).toBeGreaterThan(ridgeHeight(-22, -14) + 3)
    }
  })
})
