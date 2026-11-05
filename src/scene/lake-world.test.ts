import { deepStrictEqual } from 'node:assert'

import { beforeAll, describe, expect, it } from 'vitest'

import { required } from '../invariant'
import { LAKE_BOUNDS, lakeIndex, WATER_LEVEL } from './lake-bed'
import type { LakeBed } from './lake-bed'
import { createLakeWorld, TREE_SPACING } from './lake-world'
import { sampleHeight } from './terrain-field'
import type { TerrainField } from './terrain-field'

// All assertions read these worlds; determinism still uses a fresh second generation.
const worlds = new Map<string, ReturnType<typeof createLakeWorld>>()
const cases = [false, true].flatMap((mobile) => [0, 9182].map((seed) => ({ mobile, seed })))
function worldFor(seed: number, mobile: boolean) {
  const key = `${seed}:${mobile}`
  let world = worlds.get(key)
  if (!world) {
    world = createLakeWorld(seed, mobile)
    worlds.set(key, world)
  }
  return world
}

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

/** Visits every corner of the composed ground inside a box. */
function corners(
  field: TerrainField,
  box: Readonly<{ minX: number; maxX: number; minZ: number; maxZ: number }>,
  visit: (x: number, z: number, height: number, land: boolean) => void,
) {
  const c0 = Math.max(0, Math.ceil((box.minX - field.minX) / field.cell))
  const c1 = Math.min(field.columns - 1, Math.floor((box.maxX - field.minX) / field.cell))
  const r0 = Math.max(0, Math.ceil((box.minZ - field.minZ) / field.cell))
  const r1 = Math.min(field.rows - 1, Math.floor((box.maxZ - field.minZ) / field.cell))
  for (let row = r0; row <= r1; row++)
    for (let column = c0; column <= c1; column++) {
      const i = row * field.columns + column
      visit(
        field.minX + column * field.cell,
        field.minZ + row * field.cell,
        required(field.heights[i]),
        field.land[i] === 1,
      )
    }
}

describe('lake world', () => {
  // Each shared fixture has its own default hook deadline. Comparisons below
  // need two worlds, but no single setup step should generate both at once.
  for (const { seed, mobile } of [
    { seed: 9182, mobile: false },
    { seed: 12, mobile: false },
    { seed: 12, mobile: true },
  ]) {
    beforeAll(() => {
      worldFor(seed, mobile)
    })
  }

  it('is deterministic and keeps the lake channel open', () => {
    const first = worldFor(9182, false)
    const second = createLakeWorld(9182, false)
    deepStrictEqual(first.field.heights, second.field.heights)
    expect(first.boulders).toEqual(second.boulders)
    expect(first.lamps.length).toBeGreaterThanOrEqual(4)
    expect(first.lamps).toEqual(second.lamps)
    expect(first.lamps.some((lamp) => lamp.x < 0)).toBe(true)
    expect(first.lamps.some((lamp) => lamp.x > 0)).toBe(true)
    let blocked = 0
    corners(first.field, { minX: 1, maxX: 3, minZ: -56, maxZ: 7 }, (_x, _z, height) => {
      if (height >= WATER_LEVEL) blocked++
    })
    expect(blocked).toBe(0)
    expect(
      first.boulders.filter((boulder) => boulder.x > 1 && boulder.x < 3 && boulder.z > -56),
    ).toEqual([])
  })

  it('plants deterministic trees on open ground, clear of water and falls', () => {
    const first = worldFor(9182, false)
    const second = createLakeWorld(9182, false)
    expect(first.trees).toEqual(second.trees)
    expect(first.trees.length).toBeGreaterThan(0)
    expect(first.trees.length).toBeLessThanOrEqual(110)
    expect(first.trees.some((tree) => tree.z < -3 && tree.z > -40)).toBe(true)
    const fall = required(first.waterfall)
    for (const tree of first.trees) {
      expect(tree.y).toBeGreaterThan(0.3)
      expect(tree.z).toBeLessThan(0)
      expect(Math.hypot(tree.x - fall.x, tree.z - fall.z)).toBeGreaterThan(2.5)
      expect(tree.scale).toBeGreaterThanOrEqual(0.65 * 0.75)
      expect(tree.scale).toBeLessThanOrEqual(1.35 * 1.35)
      expect(['spruce', 'pine', 'birch']).toContain(tree.kind)
    }
    for (let a = 0; a < first.trees.length; a++)
      for (let b = a + 1; b < first.trees.length; b++) {
        const left = required(first.trees[a]),
          right = required(first.trees[b])
        expect((left.x - right.x) ** 2 + (left.z - right.z) ** 2).toBeGreaterThanOrEqual(
          TREE_SPACING ** 2,
        )
      }
    expect(worldFor(12, true).trees.length).toBeLessThanOrEqual(30)
    // Birches stay in the mid-ground band, as in Last Signal's diorama.
    expect(first.trees.filter((tree) => tree.kind === 'birch').every((tree) => tree.z > -40)).toBe(
      true,
    )
    // Groves: both conifers and birches appear on the default seed.
    expect(new Set(first.trees.map((tree) => tree.kind)).size).toBeGreaterThan(1)
  })

  it.each(cases)(
    'seeds three detached right islands while keeping the lake channel open (mobile=$mobile, seed=$seed)',
    ({ mobile, seed }) => {
      const world = worldFor(seed, mobile)
      const islands = rightIslands(world.lakeBed, mobile)
      expect(islands).toHaveLength(3)
      for (let index = 1; index < islands.length; index++)
        expect(required(islands[index - 1]).maxZ).toBeLessThan(required(islands[index]).minZ)
      for (let z = -50; z <= -5; z++)
        expect(world.lakeBed.water[lakeIndex(world.lakeBed, mobile ? 2 / 2.8 : 2, z)]).toBe(255)
    },
  )

  it.each([false, true])(
    'varies island layouts and floating lights with the seed (mobile=%s)',
    (mobile) => {
      const first = worldFor(0, mobile)
      const second = worldFor(9182, mobile)
      expect(rightIslands(first.lakeBed, mobile)).not.toEqual(rightIslands(second.lakeBed, mobile))
      expect(first.lamps).not.toEqual(second.lamps)
    },
  )

  it('uses a materially lighter mobile world while retaining the lake corridor', () => {
    const desktop = worldFor(12, false)
    const mobile = worldFor(12, true)
    expect(mobile.field.heights.length).toBeLessThan(desktop.field.heights.length / 3)
    expect(mobile.boulders.length).toBeLessThan(desktop.boulders.length)
    expect(mobile.lamps.some((lamp) => lamp.x < 0)).toBe(true)
    expect(mobile.lamps.some((lamp) => lamp.x > 0)).toBe(true)
    expect(mobile.suggestedCamera.position).toEqual([0, 2.5, 16])
  })

  it.each(cases)(
    'keeps floating lights over solid land with independent safe motion (mobile=$mobile, seed=$seed)',
    ({ mobile, seed }) => {
      const world = worldFor(seed, mobile)
      expect(world.lamps.filter((lamp) => lamp.x < 0 && lamp.z < 0).length).toBeGreaterThanOrEqual(
        2,
      )
      expect(world.lamps.filter((lamp) => lamp.x > 0 && lamp.z < 0).length).toBeGreaterThanOrEqual(
        2,
      )
      expect(world.lamps.filter((lamp) => lamp.z > 2).length).toBeLessThanOrEqual(1)
      expect(world.lamps.length).toBeLessThanOrEqual(mobile ? 5 : 7)
      expect(new Set(world.lamps.map((lamp) => lamp.speed)).size).toBe(world.lamps.length)
      expect(new Set(world.lamps.map((lamp) => lamp.phase)).size).toBe(world.lamps.length)
      for (const [index, lamp] of world.lamps.entries()) {
        for (const other of world.lamps.slice(index + 1)) {
          const closestApproach =
            Math.hypot(lamp.x - other.x, lamp.z - other.z) -
            (lamp.driftRadius + other.driftRadius) * Math.hypot(1, 0.7)
          expect(closestApproach).toBeGreaterThan(mobile ? 8 : 12)
        }
        for (const dx of [-lamp.driftRadius - 0.085, 0, lamp.driftRadius + 0.085])
          for (const dz of [-lamp.driftRadius * 0.7 - 0.085, 0, lamp.driftRadius * 0.7 + 0.085]) {
            const ground = sampleHeight(world.field, lamp.x + dx, lamp.z + dz)
            expect(ground).toBeGreaterThan(WATER_LEVEL)
            expect(lamp.y - lamp.amplitude - 0.085).toBeGreaterThan(ground)
          }
      }
    },
  )

  it.each([false, true])(
    'brings a low shore in beneath the camera, with open water to its right (mobile=%s)',
    (mobile) => {
      const world = worldFor(9182, mobile)
      let near = 0
      corners(world.field, { minX: -12, maxX: -0.6, minZ: 4, maxZ: 12 }, (_x, _z, height) => {
        if (height > WATER_LEVEL + 0.05 && height < 0.6) near++
      })
      expect(near).toBeGreaterThan(mobile ? 50 : 300)
      expect(sampleHeight(world.field, mobile ? 1 : 4, 6)).toBeLessThan(WATER_LEVEL)
    },
  )

  it.each(cases)(
    'sets the composed stones in the water as boulders reaching below the swell (mobile=$mobile, seed=$seed)',
    ({ mobile, seed }) => {
      const world = worldFor(seed, mobile)
      for (const [px, z] of [
        [-41, -8],
        [-39, -10],
        [-36, -8.5],
        [-30, -9],
        [-27, -7.5],
      ] as const) {
        const x = mobile ? px / 2.8 : px
        // Open water around the stone, unless the bank has grown over it.
        if (sampleHeight(world.field, x, z) >= WATER_LEVEL) continue
        // Touching stones merge into one larger block, centred among its fingers' stones.
        const stone = world.boulders.find(
          (boulder) => Math.hypot(boulder.x - x, boulder.z - z) < 1.2,
        )
        expect(stone, `${x},${z}`).toBeDefined()
        expect(required(stone).y - required(stone).size[1]).toBeLessThanOrEqual(-0.4)
        // Standing out of the water, or just awash.
        expect(required(stone).y + required(stone).size[1]).toBeGreaterThan(WATER_LEVEL - 0.04)
      }
    },
  )

  it.each([0, 9182])(
    'shapes two left headlands around a deep inlet and holds the right bank farther away (seed=%s)',
    (seed) => {
      const world = worldFor(seed, false)
      // The bank nearest the camera within a band of x, on the lake's own grid (z < 2).
      const frontEdge = (minX: number, maxX: number) => {
        let front = -Infinity
        corners(world.field, { minX, maxX: maxX - 1e-6, minZ: -70, maxZ: 2 }, (_x, z, _h, land) => {
          if (land) front = Math.max(front, z)
        })
        return front
      }

      expect(frontEdge(-38, -30)).toBeLessThan(-30)
      expect(frontEdge(-38, -30)).toBeLessThan(frontEdge(-51, -42) - 18)
      expect(frontEdge(-38, -30)).toBeLessThan(frontEdge(-22, -16) - 20)
      expect(frontEdge(-13, -9)).toBeLessThan(frontEdge(-22, -16) - 8)
      expect(frontEdge(35, 43)).toBeLessThan(frontEdge(-22, -16) - 10)
    },
  )

  it.each([0, 9182])(
    'raises the outer left bank and distant right ridge without filling the lake (seed=%s)',
    (seed) => {
      const world = worldFor(seed, false)
      const ridgeHeight = (minX: number, maxX: number, minZ = -45, maxZ = -12) => {
        const heights: number[] = []
        corners(world.field, { minX, maxX, minZ, maxZ }, (_x, _z, height, land) => {
          if (land) heights.push(height)
        })
        heights.sort((a, b) => a - b)
        return required(heights[Math.floor(heights.length * 0.9)])
      }

      expect(ridgeHeight(-52, -43)).toBeGreaterThan(ridgeHeight(-22, -14) + 3)
      expect(ridgeHeight(54, 66, -75, -35)).toBeGreaterThan(ridgeHeight(-22, -14) + 3)
    },
  )
})
