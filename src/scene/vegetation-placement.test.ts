import { describe, expect, it } from 'vitest'

import { ATLAS_TILES, bakeFoliageAtlas, tileCoverage } from './foliage-atlas'
import { WATER_LEVEL } from './lake-bed'
import { MeshBuilder, appendTuft } from './vegetation-meshes'
import { foliageSeeds, meshSculpt, sculptSpruce, VoxelSculpt } from './vegetation-models'
import { prepareVegetation } from './vegetation-placement'
import { createVoxelWorld } from './voxel-world'

const triangles = (vegetation: ReturnType<typeof prepareVegetation>) =>
  (vegetation.wood.indices.length +
    vegetation.foliage.indices.length +
    vegetation.undergrowth.indices.length) /
  3

describe('Last Signal vegetation', () => {
  it('meshes only exposed wood faces, with corner occlusion and outward winding', () => {
    const sculpt = new VoxelSculpt(0.1)
    sculpt.voxel([0.05, 0.05, 0.05], [1, 1, 1])
    sculpt.voxel([0.15, 0.05, 0.05], [1, 1, 1])
    sculpt.voxel([0.15, 0.15, 0.05], [1, 1, 1])
    // Foliage cells never become voxel faces.
    sculpt.kind = 'needle'
    sculpt.voxel([0.05, 0.15, 0.05], [0, 1, 0])
    const mesh = meshSculpt(sculpt, { seed: 1, relief: 0, bendFrom: 0 })
    // An L of three wood cubes sharing two faces: 14 exposed faces, 4 vertices and 2 triangles each.
    expect(mesh.positions.length / 3).toBe(56)
    expect(mesh.indices.length).toBe(84)
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => (mesh.indices[i + k] ?? 0) * 3)
      const p = (v: number, axis: number) => mesh.positions[v + axis] ?? 0
      const e1 = [0, 1, 2].map((axis) => p(b ?? 0, axis) - p(a ?? 0, axis))
      const e2 = [0, 1, 2].map((axis) => p(c ?? 0, axis) - p(a ?? 0, axis))
      const cross = [
        (e1[1] ?? 0) * (e2[2] ?? 0) - (e1[2] ?? 0) * (e2[1] ?? 0),
        (e1[2] ?? 0) * (e2[0] ?? 0) - (e1[0] ?? 0) * (e2[2] ?? 0),
        (e1[0] ?? 0) * (e2[1] ?? 0) - (e1[1] ?? 0) * (e2[0] ?? 0),
      ]
      const n = [0, 1, 2].map((axis) => (mesh.normals[(a ?? 0) + axis] ?? 0) / 127)
      expect(cross.reduce((sum, value, axis) => sum + value * (n[axis] ?? 0), 0)).toBeGreaterThan(0)
    }
    const colours = Array.from(mesh.colors)
    expect(Math.min(...colours)).toBeLessThan(Math.max(...colours))
  })

  it('reduces a spruce crown to clump seeds that face open air', () => {
    const sculpt = sculptSpruce(7, 0.08, false)
    const seeds = foliageSeeds(sculpt, 3)
    expect(seeds.length).toBeGreaterThan(30)
    for (const seed of seeds) {
      expect(Math.hypot(...seed.open)).toBeCloseTo(1, 5)
      expect(seed.openness).toBeGreaterThan(0)
      expect(seed.openness).toBeLessThanOrEqual(1)
      expect(seed.leaf).toBe(false)
    }
    // Seeds on the crown's flanks open outward, away from the trunk.
    const outward = seeds.filter(
      (seed) => seed.open[0] * seed.center[0] + seed.open[2] * seed.center[2] > 0,
    ).length
    expect(outward / seeds.length).toBeGreaterThan(0.6)
  })

  it('bakes a botanical atlas with Last Signal coverage targets', () => {
    const atlas = bakeFoliageAtlas(3)
    expect(atlas.data.length).toBe(atlas.width * atlas.height * 4)
    for (const tile of [ATLAS_TILES.needleA, ATLAS_TILES.needleB]) {
      expect(tileCoverage(atlas, tile)).toBeGreaterThan(0.2)
      expect(tileCoverage(atlas, tile)).toBeLessThan(0.75)
    }
    for (const tile of [ATLAS_TILES.leafA, ATLAS_TILES.leafB])
      expect(tileCoverage(atlas, tile)).toBeGreaterThan(0.25)
    expect(tileCoverage(atlas, ATLAS_TILES.disc)).toBeGreaterThan(0.4)
  })

  it('builds grass blades as tapered ribbons rooted at the tuft', () => {
    const builder = new MeshBuilder(false)
    appendTuft(builder, [0, 0, 0], {
      blades: 8,
      height: 0.3,
      width: 0.02,
      colours: { root: [0.07, 0.1, 0.05], tip: [0.2, 0.26, 0.09] },
      salt: 1,
      phase: 0,
    })
    const mesh = builder.build()
    // Four rows of two vertices plus a tip per blade; three quads and a tip triangle.
    expect(mesh.positions.length / 3).toBe(8 * 9)
    expect(mesh.indices.length / 3).toBe(8 * 7)
    const heights = Array.from(
      { length: mesh.positions.length / 3 },
      (_, i) => mesh.positions[i * 3 + 1] ?? 0,
    )
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...heights)).toBeLessThanOrEqual(0.3)
  })

  it('builds ground-cover blades as two rows and a tip', () => {
    const builder = new MeshBuilder(false)
    appendTuft(builder, [0, 0, 0], {
      blades: 5,
      height: 0.1,
      width: 0.02,
      colours: { root: [0.07, 0.1, 0.05], tip: [0.2, 0.26, 0.09] },
      salt: 2,
      phase: 0,
      profile: 'short',
    })
    const mesh = builder.build()
    // Two rows of two vertices plus a tip per blade; one quad and a tip triangle.
    expect(mesh.positions.length / 3).toBe(5 * 5)
    expect(mesh.indices.length / 3).toBe(5 * 3)
  })

  it('is deterministic and stays within a triangle budget', () => {
    for (const mobile of [false, true]) {
      const world = createVoxelWorld(9182, mobile)
      const first = prepareVegetation(world, 9182, mobile)
      const second = prepareVegetation(world, 9182, mobile)
      expect(Array.from(first.foliage.positions)).toEqual(Array.from(second.foliage.positions))
      expect(Array.from(first.undergrowth.positions)).toEqual(
        Array.from(second.undergrowth.positions),
      )
      expect(first.foliage.indices.length).toBeGreaterThan(0)
      expect(first.undergrowth.indices.length).toBeGreaterThan(0)
      expect(triangles(first)).toBeLessThan(mobile ? 120_000 : 320_000)
      for (let i = 1; i < first.undergrowth.positions.length; i += 3)
        expect(first.undergrowth.positions[i] ?? 0).toBeGreaterThan(WATER_LEVEL)
    }
  }, 30_000)
})
