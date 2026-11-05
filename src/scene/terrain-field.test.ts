import { describe, expect, it } from 'vitest'

import { required } from '../invariant'
import { lakeIndex, WATER_LEVEL } from './lake-bed'
import { createLakeWorld } from './lake-world'
import { createPhysicsWorld, loadPhysics } from './physics-world'
import { prepareBoulders } from './terrain-boulders'
import { createTerrainField, sampleHeight, sampleNormal } from './terrain-field'
import type { TerrainGrid } from './terrain-field'
import { prepareTerrainColliders, prepareTerrainSurface } from './terrain-surface'
import type { Voxel } from './voxel-spatial'

const grid: TerrainGrid = { minX: -4.125, minZ: -4.125, cell: 0.25, columns: 34, rows: 34 }

/** A stepped mound: square terraces 0.25 m high, like the voxel source. */
function terraces(): Voxel[] {
  const voxels: Voxel[] = []
  for (let x = -2.5; x <= 2.5; x += 0.25)
    for (let z = -2.5; z <= 2.5; z += 0.25) {
      const ring = Math.max(Math.abs(x), Math.abs(z))
      const top = Math.max(0.25, 1.25 - Math.floor(ring / 0.5) * 0.25)
      for (let y = 0.125; y < top; y += 0.25) voxels.push({ x, y, z, size: 0.25, color: 0 })
    }
  return voxels
}

/** Corner heights of stacked cubes: each corner takes the highest top touching it. */
function rasterize(voxels: readonly Voxel[], rockValue = 0) {
  const heights = new Float32Array(grid.columns * grid.rows).fill(Number.NaN)
  for (const voxel of voxels) {
    const half = voxel.size / 2
    for (let row = 0; row < grid.rows; row++)
      for (let column = 0; column < grid.columns; column++) {
        const x = grid.minX + column * grid.cell,
          z = grid.minZ + row * grid.cell
        if (Math.abs(x - voxel.x) > half + 1e-4 || Math.abs(z - voxel.z) > half + 1e-4) continue
        const i = row * grid.columns + column
        heights[i] = Math.max(
          voxel.y + half,
          Number.isNaN(heights[i] ?? 0) ? -Infinity : (heights[i] ?? 0),
        )
      }
  }
  return { heights, rock: new Float32Array(heights.length).fill(rockValue), grid }
}

const worlds = new Map<boolean, ReturnType<typeof createLakeWorld>>()
const worldFor = (mobile: boolean) => {
  let world = worlds.get(mobile)
  if (!world) {
    world = createLakeWorld(9182, mobile)
    worlds.set(mobile, world)
  }
  return world
}

describe('terrain field', () => {
  it('smooths voxel terraces into continuous slopes without moving the composition', () => {
    const { field } = createTerrainField({
      ...rasterize(terraces()),
      seed: 1,
      mobile: false,
      protect: [],
    })
    // No step remains: neighbouring corners differ far less than a voxel along a terrace edge.
    let largest = 0
    for (let row = 4; row < grid.rows - 4; row++)
      for (let column = 4; column < grid.columns - 5; column++) {
        const i = row * grid.columns + column
        largest = Math.max(
          largest,
          Math.abs(required(field.heights[i + 1]) - required(field.heights[i])),
        )
      }
    expect(largest).toBeLessThan(0.2)
    // The mound keeps its height and its footprint; open water stays below the surface.
    expect(sampleHeight(field, 0, 0)).toBeGreaterThan(0.8)
    expect(sampleHeight(field, 3.6, 3.6)).toBeLessThan(WATER_LEVEL)
  })

  it('keeps exact areas as composed, never lowers raised rims and opens water areas', () => {
    const base = { ...rasterize(terraces()), seed: 1, mobile: false }
    const plain = createTerrainField({ ...base, protect: [] }).field
    const exact = createTerrainField({
      ...base,
      protect: [{ x: 1.875, z: 0, radius: 0.3 }],
    }).field
    // Corner (x=1.875) sits between the 0.5 m terrace and the 0.25 m one: the highest top
    // touching it is kept exactly.
    expect(sampleHeight(exact, 1.875, 0)).toBeCloseTo(0.5, 5)
    const raised = createTerrainField({
      ...base,
      protect: [{ x: 0, z: 0, radius: 0.6, mode: 'raise' }],
    }).field
    for (const [x, z] of [
      [0, 0],
      [0.375, 0.125],
      [-0.375, -0.375],
    ] as const)
      expect(sampleHeight(raised, x, z)).toBeGreaterThanOrEqual(1.25 - 1e-6)
    expect(sampleHeight(plain, 0, 0)).toBeLessThan(sampleHeight(raised, 0, 0) + 1e-6)
    const open = createTerrainField({
      ...base,
      protect: [{ x: 0, z: 0, radius: 0.4, mode: 'water' }],
    }).field
    expect(sampleHeight(open, 0, 0)).toBeLessThan(WATER_LEVEL - 0.2)
  })

  it('turns single stones into boulders instead of bumps', () => {
    const stone: Voxel = { x: 0, y: 0.06, z: 0, size: 0.25, color: 0 }
    const { field, islands } = createTerrainField({
      ...rasterize([stone], 1),
      seed: 1,
      mobile: false,
      protect: [],
    })
    expect(islands).toHaveLength(1)
    expect(sampleHeight(field, 0, 0)).toBeLessThan(WATER_LEVEL)
  })

  it.each([false, true])('derives the lake from the smooth ground (mobile=%s)', (mobile) => {
    const world = worldFor(mobile)
    const { field, lakeBed } = world
    let checked = 0
    for (let z = -60; z < 10; z += 0.7)
      for (let x = -70; x < 70; x += 0.7) {
        const h = sampleHeight(field, x, z)
        // Away from the contour (no crossing within a raster cell), the water mask agrees with
        // the ground height.
        const side = h < WATER_LEVEL
        if (
          [-0.8, 0, 0.8].some((dx) =>
            [-0.8, 0, 0.8].some((dz) => sampleHeight(field, x + dx, z + dz) < WATER_LEVEL !== side),
          )
        )
          continue
        if (world.boulders.some((b) => Math.hypot(b.x - x, b.z - z) < Math.max(...b.size) + 0.7))
          continue
        const index = lakeIndex(lakeBed, x, z)
        if (index < 0) continue
        expect(lakeBed.water[index]).toBe(h < WATER_LEVEL ? 255 : 0)
        checked++
      }
    expect(checked).toBeGreaterThan(1000)
  })

  it.each([false, true])('seats trees and lanterns on the smooth ground (mobile=%s)', (mobile) => {
    const world = worldFor(mobile)
    for (const tree of world.trees) {
      expect(tree.y).toBeLessThanOrEqual(sampleHeight(world.field, tree.x, tree.z) + 1e-6)
      expect(tree.y).toBeGreaterThan(WATER_LEVEL)
    }
    for (const lamp of world.lamps)
      expect(lamp.groundY).toBeCloseTo(sampleHeight(world.field, lamp.x, lamp.z), 6)
  })
})

describe('terrain surface', () => {
  it.each([false, true])(
    'faces up, stays within budget and is deterministic (mobile=%s)',
    (mobile) => {
      const world = worldFor(mobile)
      const surface = prepareTerrainSurface(world.field, world.trees, mobile)
      expect(surface.triangles).toBeLessThan(mobile ? 60_000 : 220_000)
      let upward = 0
      for (let t = 0; t < surface.indices.length; t += 3) {
        const [a, b, c] = [0, 1, 2].map((k) => required(surface.indices[t + k]) * 3)
        const p = (v: number, axis: number) => required(surface.positions[v + axis])
        const ux = p(required(b), 0) - p(required(a), 0),
          uz = p(required(b), 2) - p(required(a), 2)
        const vx = p(required(c), 0) - p(required(a), 0),
          vz = p(required(c), 2) - p(required(a), 2)
        // y component of (b - a) × (c - a): every triangle of a heightfield winds upward.
        if (uz * vx - ux * vz > 0) upward++
      }
      expect(upward / (surface.indices.length / 3)).toBeGreaterThan(0.995)
      const again = prepareTerrainSurface(world.field, world.trees, mobile)
      expect(again.positions).toEqual(surface.positions)
      expect(again.surface).toEqual(surface.surface)
    },
  )

  it('collides where the ground is drawn', async () => {
    const world = worldFor(true)
    const colliders = prepareTerrainColliders(
      world.field,
      prepareBoulders(world.boulders, world.seed),
    )
    const physics = createPhysicsWorld(await loadPhysics(), colliders)
    try {
      let hits = 0
      for (let z = -40; z < 8; z += 1.3)
        for (let x = -25; x < 25; x += 1.3) {
          const ground = sampleHeight(world.field, x, z)
          if (ground < WATER_LEVEL + 0.1 || sampleNormal(world.field, x, z)[1] < 0.92) continue
          if (world.boulders.some((b) => Math.hypot(b.x - x, b.z - z) < Math.max(...b.size) + 0.2))
            continue
          const distance = physics.castDistance({ x, y: 20, z }, { x: 0, y: -1, z: 0 }, 40)
          expect(distance, `${x},${z}`).not.toBeNull()
          // The rendered mesh shifts cliffs a little; on gentle ground both agree closely.
          expect(Math.abs(20 - (distance ?? 0) - ground)).toBeLessThan(0.05)
          hits++
        }
      expect(hits).toBeGreaterThan(20)
      // Open water has no floor near the surface.
      const deep = physics.castDistance({ x: 0, y: 5, z: -20 }, { x: 0, y: -1, z: 0 }, 9)
      expect(deep).toBeNull()
    } finally {
      physics.dispose()
    }
  })
})

describe('boulders', () => {
  it.each([false, true])(
    'stay within budget, off the waterfall and seated (mobile=%s)',
    (mobile) => {
      const world = worldFor(mobile)
      expect(world.boulders.length).toBeGreaterThan(mobile ? 20 : 80)
      expect(world.boulders.length).toBeLessThanOrEqual(mobile ? 90 : 320)
      const fall = required(world.waterfall)
      const [nx, nz] = fall.direction
      const inLanding = world.boulders.filter((boulder) => {
        const along = (boulder.x - fall.x) * nx + (boulder.z - fall.z) * nz
        const across = (boulder.x - fall.x) * nz - (boulder.z - fall.z) * nx
        return along > 0 && along < 2.4 && Math.abs(across) <= fall.width / 2 + 1
      })
      expect(inLanding).toEqual([])
      // Partly buried, or reaching below the wave trough in open water.
      const floating = world.boulders.filter(
        (boulder) =>
          Math.max(sampleHeight(world.field, boulder.x, boulder.z), WATER_LEVEL - 0.5) <=
          boulder.y - boulder.size[1],
      )
      expect(floating).toEqual([])
      const mesh = prepareBoulders(world.boulders, world.seed)
      expect(mesh.indices.length / 3).toBeLessThan(mobile ? 30_000 : 105_000)
    },
  )
})
