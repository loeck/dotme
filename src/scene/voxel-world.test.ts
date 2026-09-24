import { describe, expect, it } from 'vitest'

import { required } from '../invariant'
import { LAKE_BOUNDS, lakeIndex } from './lake-bed'
import type { LakeBed } from './lake-bed'
import { createVoxelWorld } from './voxel-world'

const inRightIslandArea = (x: number, z: number) => x > 3 && x < 22 && z > -52 && z < -5

/** Connected solid footprints must be surrounded by water, including diagonal neighbors. */
function rightIslands(bed: LakeBed, mobile: boolean) {
  const visited = new Uint8Array(bed.water.length)
  const cellSize = LAKE_BOUNDS.size / bed.resolution
  const position = (index: number) => ({
    x: (LAKE_BOUNDS.minX + ((index % bed.resolution) + 0.5) * cellSize) * (mobile ? 2.8 : 1),
    z: LAKE_BOUNDS.minZ + (Math.floor(index / bed.resolution) + 0.5) * cellSize,
  })
  const islands: { minX: number; maxX: number; minZ: number; maxZ: number; cells: number }[] = []
  for (let start = 0; start < bed.water.length; start++) {
    const origin = position(start)
    if (visited[start] || bed.water[start] !== 0 || !inRightIslandArea(origin.x, origin.z)) continue
    const pending = [start]
    visited[start] = 1
    let enclosed = true
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const index = required(pending[cursor])
      const { x, z } = position(index)
      enclosed &&= inRightIslandArea(x, z)
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minZ = Math.min(minZ, z)
      maxZ = Math.max(maxZ, z)
      const column = index % bed.resolution
      const row = Math.floor(index / bed.resolution)
      for (const dx of [-1, 0, 1])
        for (const dz of [-1, 0, 1]) {
          const nx = column + dx,
            nz = row + dz
          if (nx < 0 || nx >= bed.resolution || nz < 0 || nz >= bed.resolution) continue
          const neighbor = nz * bed.resolution + nx
          if (visited[neighbor] || bed.water[neighbor] !== 0) continue
          visited[neighbor] = 1
          pending.push(neighbor)
        }
    }
    if (enclosed && pending.length >= 4)
      islands.push({ minX, maxX, minZ, maxZ, cells: pending.length })
  }
  return islands.toSorted((a, b) => a.minZ - b.minZ)
}

describe('voxel lake world', () => {
  it('is deterministic and keeps desktop within an instancing budget', () => {
    const first = createVoxelWorld(9182, false)
    const second = createVoxelWorld(9182, false)
    expect(first.voxels).toEqual(second.voxels)
    expect(first.voxels.length).toBeGreaterThan(8_000)
    expect(first.voxels.length).toBeLessThan(70_000)
    expect(first.lamps.length).toBeGreaterThanOrEqual(4)
    expect(first.lamps).toEqual(second.lamps)
    expect(first.lamps.some((lamp) => lamp.x < 0)).toBe(true)
    expect(first.lamps.some((lamp) => lamp.x > 0)).toBe(true)
    expect(first.groups).not.toHaveProperty('treeLeaf')
    expect(first.groups).not.toHaveProperty('treeTrunk')
    for (const material of ['ground', 'shore', 'rock'] as const) {
      const positions = first.groups[material].positions
      for (let index = 0; index < positions.length; index += 3) {
        const x = required(positions[index])
        const z = required(positions[index + 2])
        expect(x > 1 && x < 3 && z > -56).toBe(false)
      }
    }
  })

  it.each([false, true])(
    'seeds three detached right islands while keeping the lake channel open (mobile=%s)',
    (mobile) => {
      const layouts = [0, 9182].map((seed) => {
        const world = createVoxelWorld(seed, mobile)
        const islands = rightIslands(world.lakeBed, mobile)
        expect(islands).toHaveLength(3)
        for (let index = 1; index < islands.length; index++)
          expect(required(islands[index - 1]).maxZ).toBeLessThan(required(islands[index]).minZ)
        for (let z = -50; z <= -5; z++)
          expect(world.lakeBed.water[lakeIndex(world.lakeBed, mobile ? 2 / 2.8 : 2, z)]).toBe(255)
        return islands
      })
      expect(layouts[0]).not.toEqual(layouts[1])
    },
  )

  it('uses a materially lighter mobile world while retaining the lake corridor', () => {
    const desktop = createVoxelWorld(12, false)
    const mobile = createVoxelWorld(12, true)
    expect(mobile.voxels.length).toBeLessThan(desktop.voxels.length)
    expect(mobile.voxels.length).toBeLessThan(22_000)
    expect(mobile.shoreCount).toBeGreaterThan(20)
    expect(mobile.lamps.some((lamp) => lamp.x < 0)).toBe(true)
    expect(mobile.lamps.some((lamp) => lamp.x > 0)).toBe(true)
    expect(mobile.groups).not.toHaveProperty('treeLeaf')
    expect(mobile.groups).not.toHaveProperty('treeTrunk')
    expect(mobile.suggestedCamera.position).toEqual([0, 2.5, 16])
  })

  it('randomizes floating lights over solid land with independent safe motion', () => {
    for (const mobile of [false, true]) {
      const worlds = [0, 9182].map((seed) => createVoxelWorld(seed, mobile))
      expect(required(worlds[0]).lamps).not.toEqual(required(worlds[1]).lamps)
      for (const world of worlds) {
        expect(
          world.lamps.filter((lamp) => lamp.x < 0 && lamp.z < 0).length,
        ).toBeGreaterThanOrEqual(2)
        expect(
          world.lamps.filter((lamp) => lamp.x > 0 && lamp.z < 0).length,
        ).toBeGreaterThanOrEqual(2)
        expect(world.lamps.filter((lamp) => lamp.z > 2).length).toBeLessThanOrEqual(1)
        expect(world.lamps.length).toBeLessThanOrEqual(mobile ? 5 : 7)
        expect(new Set(world.lamps.map((lamp) => lamp.speed)).size).toBe(world.lamps.length)
        expect(new Set(world.lamps.map((lamp) => lamp.phase)).size).toBe(world.lamps.length)
        const terrain = world.voxels.slice(
          0,
          world.groups.ground.count + world.groups.shore.count + world.groups.rock.count,
        )
        for (const [index, lamp] of world.lamps.entries()) {
          for (const other of world.lamps.slice(index + 1)) {
            const closestApproach =
              Math.hypot(lamp.x - other.x, lamp.z - other.z) -
              (lamp.driftRadius + other.driftRadius) * Math.hypot(1, 0.7)
            expect(closestApproach).toBeGreaterThan(mobile ? 8 : 12)
          }
          for (const dx of [-lamp.driftRadius - 0.085, 0, lamp.driftRadius + 0.085])
            for (const dz of [-lamp.driftRadius * 0.7 - 0.085, 0, lamp.driftRadius * 0.7 + 0.085]) {
              const beneath = terrain.filter(
                (voxel) =>
                  Math.abs(lamp.x + dx - voxel.x) <= voxel.size / 2 + 1e-5 &&
                  Math.abs(lamp.z + dz - voxel.z) <= voxel.size / 2 + 1e-5,
              )
              expect(beneath.length).toBeGreaterThan(0)
              const ground = Math.max(...beneath.map((voxel) => voxel.y + voxel.size / 2))
              expect(lamp.y - lamp.amplitude - 0.085).toBeGreaterThan(ground)
            }
        }
      }
    }
  })

  it('keeps the original voxel sizes and closes every exposed terrain column, including the far-grid seam', () => {
    for (const mobile of [false, true]) {
      const world = createVoxelWorld(9182, mobile)
      expect(world.voxelSize).toBe(mobile ? 0.28 : 0.25)
      const terrainEnd =
        world.groups.ground.count + world.groups.shore.count + world.groups.rock.count
      const terrain = world.voxels.slice(0, terrainEnd)
      for (const foreground of [false, true]) {
        const step = world.voxelSize * (foreground ? 0.5 : 1)
        const originX = foreground ? (mobile ? -4.2 : -12) : 0
        const originZ = foreground ? (mobile ? 5 : 3) : 7
        const covered = new Map<string, { bottom: number; top: number }>()
        for (const voxel of terrain) {
          if (voxel.z > 2 !== foreground) continue
          const span = Math.round(voxel.size / step)
          const gx = (voxel.x - originX) / step - (span - 1) / 2
          const gz = (voxel.z - originZ) / step - (span - 1) / 2
          const top = voxel.y + voxel.size / 2
          // Detached decorative stones are separate closed cubes, outside the terrain lattice.
          if (
            Math.abs(gx - Math.round(gx)) > 1e-4 ||
            Math.abs(gz - Math.round(gz)) > 1e-4 ||
            Math.abs(top / step - Math.round(top / step)) > 1e-4
          )
            continue
          for (let dx = 0; dx < span; dx += 1)
            for (let dz = 0; dz < span; dz += 1) {
              const key = `${Math.round(gx) + dx}:${Math.round(gz) + dz}`
              const column = covered.get(key)
              covered.set(key, {
                bottom: Math.min(column?.bottom ?? Infinity, voxel.y - voxel.size / 2),
                top: Math.max(column?.top ?? -Infinity, top),
              })
            }
        }
        expect(covered.size).toBeGreaterThan(foreground ? 500 : 10_000)
        let largestGap = 0
        for (const [key, column] of covered) {
          const [x = NaN, z = NaN] = key.split(':').map(Number)
          const lowerNeighbor = Math.min(
            ...[`${x - 1}:${z}`, `${x + 1}:${z}`, `${x}:${z - 1}`, `${x}:${z + 1}`].map(
              (neighbor) => covered.get(neighbor)?.top ?? -0.4,
            ),
          )
          largestGap = Math.max(largestGap, column.bottom - lowerNeighbor)
        }
        expect(largestGap).toBeLessThan(1e-5)
      }
    }
  })

  it('centers isolated rocks at Y = 0 with continuous support below the lowest water swell', () => {
    for (const mobile of [false, true]) {
      for (const seed of [0, 9182]) {
        const world = createVoxelWorld(seed, mobile)
        const terrainEnd =
          world.groups.ground.count + world.groups.shore.count + world.groups.rock.count
        const terrain = world.voxels.slice(0, terrainEnd)
        for (const [px, z] of [
          [-41, -8],
          [-39, -10],
          [-36, -8.5],
          [-30, -9],
          [-27, -7.5],
        ] as const) {
          const x = mobile ? px / 2.8 : px
          const rocks = terrain
            .filter((voxel) => Math.abs(voxel.x - x) < 1e-5 && Math.abs(voxel.z - z) < 1e-5)
            .toSorted((a, b) => a.y - b.y)
          expect(rocks.length).toBeGreaterThan(0)
          expect(required(rocks[0]).y - required(rocks[0]).size / 2).toBeLessThanOrEqual(
            -0.4 + 1e-5,
          )
          expect(required(rocks.at(-1)).y).toBe(0)
          for (let index = 1; index < rocks.length; index += 1) {
            const lower = required(rocks[index - 1])
            const upper = required(rocks[index])
            expect(upper.y - upper.size / 2).toBeLessThanOrEqual(lower.y + lower.size / 2 + 1e-5)
          }
        }
      }
    }
  })

  it('shapes two left headlands around a deep inlet and holds the right bank farther away', () => {
    for (const seed of [0, 9182]) {
      const world = createVoxelWorld(seed, false)
      const frontEdge = (minX: number, maxX: number) => {
        const depths: number[] = []
        for (let index = 0; index < world.shores.length; index += 3) {
          const x = required(world.shores[index])
          if (x >= minX && x < maxX) depths.push(required(world.shores[index + 2]))
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
            const x = required(positions[index])
            const z = required(positions[index + 2])
            if (x >= minX && x < maxX && z > minZ && z < maxZ)
              heights.push(required(positions[index + 1]))
          }
        }
        heights.sort((a, b) => a - b)
        return required(heights[Math.floor(heights.length * 0.9)])
      }

      expect(ridgeHeight(-52, -43)).toBeGreaterThan(ridgeHeight(-22, -14) + 3)
      expect(ridgeHeight(54, 66, -75, -35)).toBeGreaterThan(ridgeHeight(-22, -14) + 3)
    }
  })
})
