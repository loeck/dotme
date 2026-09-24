import { describe, expect, it } from 'vitest'

import { required } from '../invariant'
import { lakeIndex, WATER_LEVEL } from './lake-bed'
import { createVoxelWorld } from './voxel-world'

describe('procedural waterfall placement', () => {
  it.each([false, true])(
    'keeps a supported source and an unobstructed water landing (mobile=%s)',
    (mobile) => {
      const world = createVoxelWorld(1, mobile)
      const fall = required(world.waterfall)
      const [nx, nz] = fall.direction
      expect(nx * nx + nz * nz).toBe(1)
      expect(fall.top - WATER_LEVEL).toBeGreaterThanOrEqual(1.3)
      expect(fall.top).toBeLessThanOrEqual(2 + 1e-6)
      expect(fall.width).toBeGreaterThanOrEqual(mobile ? 0.7 : 1.5)
      expect(fall.width).toBeLessThanOrEqual(mobile ? 1 : 2)
      expect(fall.x).toBeLessThan(0)
      expect(fall.z).toBeGreaterThanOrEqual(-34)
      expect(fall.z).toBeLessThanOrEqual(-12)
      for (let across = -4; across <= 4; across++) {
        const offset = (fall.width * across) / 8
        const sourceX = fall.x + nz * offset
        const sourceZ = fall.z - nx * offset
        const supportX = sourceX - nx * 0.04
        const supportZ = sourceZ - nz * 0.04
        expect(
          world.voxels.some(
            (voxel) =>
              Math.abs(voxel.x - supportX) <= voxel.size / 2 + 1e-6 &&
              Math.abs(voxel.z - supportZ) <= voxel.size / 2 + 1e-6 &&
              voxel.y + voxel.size / 2 >= fall.top - world.voxelSize - 1e-6 &&
              voxel.y + voxel.size / 2 <= fall.top - world.voxelSize + 1e-6,
          ),
        ).toBe(true)
        const landing = lakeIndex(world.lakeBed, sourceX + nx * 0.8, sourceZ + nz * 0.8)
        expect(world.lakeBed.water[landing]).toBe(255)
        expect(required(world.lakeBed.obstacle[landing])).toBeLessThan(WATER_LEVEL)
        for (let step = 1; step <= 12; step++) {
          const t = step / 12
          const x = sourceX + nx * 0.8 * t,
            z = sourceZ + nz * 0.8 * t
          const y = fall.top - (fall.top - WATER_LEVEL) * t * t
          expect(
            world.voxels.some(
              (voxel) =>
                Math.abs(voxel.x - x) < voxel.size / 2 &&
                Math.abs(voxel.z - z) < voxel.size / 2 &&
                voxel.y + voxel.size / 2 > y,
            ),
          ).toBe(false)
        }
      }
      expect(fall.basin.length).toBeGreaterThan(mobile ? 9 : 19)
      const acrossBasin = fall.basin.map((cell) => cell.x * nz - cell.z * nx)
      expect(Math.max(...acrossBasin) - Math.min(...acrossBasin) + world.voxelSize).toBeGreaterThan(
        fall.width * 1.4,
      )
      const basinKey = (x: number, z: number) =>
        `${Math.round(x / world.voxelSize)}:${Math.round(z / world.voxelSize)}`
      const wetCells = new Set(fall.basin.map((cell) => basinKey(cell.x, cell.z)))
      for (const cell of fall.basin) {
        const solids = world.voxels.filter(
          (voxel) =>
            Math.abs(voxel.x - cell.x) < voxel.size / 2 &&
            Math.abs(voxel.z - cell.z) < voxel.size / 2,
        )
        expect(solids.length).toBeGreaterThan(0)
        expect(Math.max(...solids.map((voxel) => voxel.y + voxel.size / 2))).toBeCloseTo(
          fall.top - world.voxelSize,
          5,
        )
        expect(world.lakeBed.water[lakeIndex(world.lakeBed, cell.x, cell.z)]).toBe(0)
        for (const [dx, dz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const x = cell.x + dx * cell.size,
            z = cell.z + dz * cell.size
          if (wetCells.has(basinKey(x, z))) continue
          const ahead = (x - fall.x) * nx + (z - fall.z) * nz
          if (ahead > 0) continue
          expect(
            world.voxels.some(
              (voxel) =>
                Math.abs(voxel.x - x) < voxel.size / 2 &&
                Math.abs(voxel.z - z) < voxel.size / 2 &&
                voxel.y + voxel.size / 2 >= fall.top + world.voxelSize - 1e-6,
            ),
          ).toBe(true)
        }
      }
      const connected = new Set<string>()
      const queue = [required(fall.basin[0])]
      for (let index = 0; index < queue.length; index++) {
        const cell = required(queue[index]),
          key = basinKey(cell.x, cell.z)
        if (connected.has(key)) continue
        connected.add(key)
        for (const neighbor of fall.basin)
          if (
            Math.abs(neighbor.x - cell.x) + Math.abs(neighbor.z - cell.z) <
              world.voxelSize + 1e-6 &&
            !connected.has(basinKey(neighbor.x, neighbor.z))
          )
            queue.push(neighbor)
      }
      expect(connected.size).toBe(fall.basin.length)
      let offset = 0
      for (const material of ['ground', 'shore', 'rock'] as const) {
        const group = world.groups[material]
        const positions = world.voxels
          .slice(offset, offset + group.count)
          .flatMap((voxel) => [voxel.x, voxel.y, voxel.z])
        expect(positions).toEqual([...group.positions])
        offset += group.count
      }
      expect(offset).toBe(world.voxels.length)
      const replay = createVoxelWorld(1, mobile)
      expect(replay.waterfall).toEqual(fall)
      expect(replay.voxels).toEqual(world.voxels)
      expect(createVoxelWorld(0, mobile).waterfall).toBeNull()
    },
  )
})
