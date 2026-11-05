import { describe, expect, it } from 'vitest'

import { ATLAS_TILES, bakeFoliageAtlas, tileCoverage } from './foliage-atlas'
import { WATER_LEVEL } from './lake-bed'
import { createLakeWorld } from './lake-world'
import { MeshBuilder, appendTuft } from './vegetation-meshes'
import { growBirch, growBush, growPine, growSpruce, MODEL_DETAIL } from './vegetation-models'
import type { TreeModel } from './vegetation-models'
import { prepareVegetation } from './vegetation-placement'

const triangles = (vegetation: ReturnType<typeof prepareVegetation>) =>
  (vegetation.wood.indices.length +
    vegetation.foliage.indices.length +
    vegetation.undergrowth.indices.length) /
  3

/** The outward-facing share of a model's wood triangles (normal against face winding). */
function outwardShare(model: TreeModel) {
  const { positions, normals, indices } = model.wood
  let outward = 0
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => (indices[i + k] ?? 0) * 3)
    const p = (v: number, axis: number) => positions[(v ?? 0) + axis] ?? 0
    const e1 = [0, 1, 2].map((axis) => p(b ?? 0, axis) - p(a ?? 0, axis))
    const e2 = [0, 1, 2].map((axis) => p(c ?? 0, axis) - p(a ?? 0, axis))
    const cross = [
      (e1[1] ?? 0) * (e2[2] ?? 0) - (e1[2] ?? 0) * (e2[1] ?? 0),
      (e1[2] ?? 0) * (e2[0] ?? 0) - (e1[0] ?? 0) * (e2[2] ?? 0),
      (e1[0] ?? 0) * (e2[1] ?? 0) - (e1[1] ?? 0) * (e2[0] ?? 0),
    ]
    const n = [0, 1, 2].map((axis) => normals[(a ?? 0) + axis] ?? 0)
    if (cross.reduce((sum, value, axis) => sum + value * (n[axis] ?? 0), 0) > 0) outward++
  }
  return outward / (indices.length / 3)
}

describe('lake-shore vegetation', () => {
  const detail = MODEL_DETAIL.desktop
  const models = {
    spruce: growSpruce(7, detail, false),
    pine: growPine(8, detail),
    birch: growBirch(9, detail),
  }

  it.each(Object.entries(models))(
    'grows a %s with outward tube wood and a lit crown',
    (_, model) => {
      expect(model.height).toBeGreaterThan(4.5)
      expect(model.height).toBeLessThan(8)
      expect(outwardShare(model)).toBeGreaterThan(0.99)
      expect(model.sprays.length).toBeGreaterThan(100)
      for (const spray of model.sprays) {
        expect(Math.hypot(...spray.normal)).toBeCloseTo(1, 5)
        expect(Math.hypot(...spray.t)).toBeCloseTo(1, 5)
        expect(Math.hypot(...spray.b)).toBeCloseTo(1, 5)
        expect(spray.shade).toBeGreaterThan(0.25)
        expect(spray.shade).toBeLessThanOrEqual(1)
        expect(spray.center[1]).toBeLessThan(model.height + 0.6)
      }
      // Cards deep inside the crown are darker than those on its outside.
      const shades = model.sprays.map((spray) => spray.shade).toSorted((a, b) => a - b)
      expect(shades[Math.floor(shades.length * 0.1)] ?? 0).toBeLessThan(
        shades[Math.floor(shades.length * 0.9)] ?? 0,
      )
    },
  )

  it('shapes each species by its habit', () => {
    const crownBottom = (model: TreeModel) =>
      Math.min(...model.sprays.map((spray) => spray.center[1])) / model.height
    // Spruce keeps branches near the ground; Scots pine is bare most of the way up.
    expect(crownBottom(models.spruce)).toBeLessThan(0.2)
    expect(crownBottom(models.pine)).toBeGreaterThan(0.4)
    // A spruce is a narrow cone: widest low down, pointed at the top.
    const width = (model: TreeModel, from: number, to: number) =>
      Math.max(
        ...model.sprays
          .filter(
            (spray) => spray.center[1] > from * model.height && spray.center[1] < to * model.height,
          )
          .map((spray) => Math.hypot(spray.center[0], spray.center[2])),
      )
    expect(width(models.spruce, 0.15, 0.35)).toBeGreaterThan(width(models.spruce, 0.75, 0.95) * 2)
    expect(width(models.spruce, 0.15, 0.35)).toBeLessThan(models.spruce.height * 0.3)
    // Birch twigs hang: their cards are about upright.
    const birchCards = models.birch.sprays.filter((spray) => spray.b[1] > 0.7).length
    expect(birchCards / models.birch.sprays.length).toBeGreaterThan(0.6)
  })

  it('is deterministic and lighter on phones', () => {
    expect(growSpruce(7, detail, false)).toEqual(models.spruce)
    const phone = growSpruce(7, MODEL_DETAIL.mobile, false)
    expect(phone.sprays.length).toBeLessThan(models.spruce.sprays.length)
    expect(phone.wood.indices.length).toBeLessThan(models.spruce.wood.indices.length)
    expect(growBush(3, detail).height).toBeLessThan(0.6)
  })

  it('bakes a botanical atlas with open, cut-out foliage', () => {
    const atlas = bakeFoliageAtlas(3)
    expect(atlas.data.length).toBe(atlas.width * atlas.height * 4)
    for (const tile of [
      ATLAS_TILES.spruceA,
      ATLAS_TILES.spruceB,
      ATLAS_TILES.pineA,
      ATLAS_TILES.pineB,
      ATLAS_TILES.birchA,
      ATLAS_TILES.birchB,
      ATLAS_TILES.bush,
    ]) {
      // Enough foliage to read as a mass, enough gaps to read as needles and leaves.
      expect(tileCoverage(atlas, tile)).toBeGreaterThan(0.12)
      expect(tileCoverage(atlas, tile)).toBeLessThan(0.7)
    }
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
      const world = createLakeWorld(9182, mobile)
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
