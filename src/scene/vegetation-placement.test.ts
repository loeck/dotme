import { describe, expect, it } from 'vitest'

import { ATLAS_TILES, bakeFoliageAtlas, tileCoverage } from './foliage-atlas'
import { appendClump } from './grass'
import { WATER_LEVEL } from './lake-bed'
import { createLakeWorld } from './lake-world'
import { MeshBuilder } from './vegetation-meshes'
import {
  growBirch,
  growBroadleaf,
  growBush,
  growPine,
  growSpruce,
  MODEL_DETAIL,
} from './vegetation-models'
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
    oak: growBroadleaf(10, detail, 'oak'),
    beech: growBroadleaf(11, detail, 'beech'),
  }

  it.each(Object.entries(models))(
    'grows a %s with outward tube wood and a lit crown',
    (name, model) => {
      expect(model.height).toBeGreaterThan(4.5)
      // A broadleaf's billows rise a little past its leader.
      expect(model.height).toBeLessThan(name === 'oak' || name === 'beech' ? 10 : 8)
      expect(outwardShare(model)).toBeGreaterThan(0.99)
      expect(model.sprays.length).toBeGreaterThan(100)
      for (const spray of model.sprays) {
        expect(Math.hypot(...spray.normal)).toBeCloseTo(1, 5)
        expect(Math.hypot(...spray.t)).toBeCloseTo(1, 5)
        expect(Math.hypot(...spray.b)).toBeCloseTo(1, 5)
        expect(spray.shade).toBeGreaterThan(0.1)
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
    // Broadleaves carry a broad, rounded crown on a clear bole: an oak's wider than a beech's,
    // both far wider than a spruce's cone at the same height.
    for (const model of [models.oak, models.beech]) {
      expect(crownBottom(model)).toBeGreaterThan(0.08)
      expect(width(model, 0.45, 0.75)).toBeGreaterThan(model.height * 0.26)
      expect(width(model, 0.45, 0.75)).toBeGreaterThan(width(models.spruce, 0.45, 0.75) * 1.5)
    }
    expect(width(models.oak, 0.45, 0.75) / models.oak.height).toBeGreaterThan(
      width(models.beech, 0.45, 0.75) / models.beech.height,
    )
  })

  it('is deterministic and lighter on phones', () => {
    expect(growSpruce(7, detail, false)).toEqual(models.spruce)
    expect(growBroadleaf(10, detail, 'oak')).toEqual(models.oak)
    const phoneOak = growBroadleaf(10, MODEL_DETAIL.mobile, 'oak')
    expect(phoneOak.sprays.length).toBeLessThan(models.oak.sprays.length)
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
      ATLAS_TILES.oakA,
      ATLAS_TILES.oakB,
      ATLAS_TILES.limeA,
      ATLAS_TILES.limeB,
    ]) {
      // Enough foliage to read as a mass, enough gaps to read as needles and leaves.
      expect(tileCoverage(atlas, tile)).toBeGreaterThan(0.12)
      expect(tileCoverage(atlas, tile)).toBeLessThan(0.7)
    }
    expect(tileCoverage(atlas, ATLAS_TILES.disc)).toBeGreaterThan(0.4)
  })

  it.each(['turf', 'wiry', 'flat', 'rush'] as const)(
    'grows a %s clump of rooted, rounded blades with dead material',
    (form) => {
      const builder = new MeshBuilder(false)
      const clump = {
        x: 0,
        z: 0,
        radius: 0.12,
        form,
        height: 0.3,
        dryness: 0.5,
        value: 1,
        seeds: form === 'wiry',
        salt: 7,
        phase: 0,
      }
      appendClump(builder, clump, () => 0, 1, 0.002)
      const mesh = builder.build()
      expect(mesh.indices.length / 3).toBeGreaterThan(20)
      let lowest = Infinity,
        highest = -Infinity,
        reach = 0
      const colours = new Set<string>()
      for (let i = 0; i < mesh.positions.length; i += 3) {
        lowest = Math.min(lowest, mesh.positions[i + 1] ?? 0)
        highest = Math.max(highest, mesh.positions[i + 1] ?? 0)
        reach = Math.max(reach, Math.hypot(mesh.positions[i] ?? 0, mesh.positions[i + 2] ?? 0))
        colours.add(Array.from(mesh.colors.slice(i, i + 3), (v) => v.toFixed(3)).join())
      }
      // Rooted at the ground, no taller than a seed stalk, within a blade's reach of the clump.
      expect(lowest).toBeGreaterThanOrEqual(-0.011)
      expect(highest).toBeLessThan(0.3 * 1.2 * 2.1)
      expect(reach).toBeLessThan(0.12 + 0.3 * 1.2 + 0.02)
      // Many shades: per-blade value, root darkening, straw and litter.
      expect(colours.size).toBeGreaterThan(form === 'rush' ? 12 : 30)
      // Normals face up-ish: rounded across the blade and blended toward the sky.
      for (let i = 1; i < mesh.normals.length; i += 3)
        expect(mesh.normals[i] ?? 0).toBeGreaterThan(0)
    },
  )

  it('thins and widens blades with distance', () => {
    const clump = {
      x: 0,
      z: 0,
      radius: 0.1,
      form: 'wiry' as const,
      height: 0.2,
      dryness: 0.2,
      value: 1,
      seeds: false,
      salt: 3,
      phase: 0,
    }
    const near = new MeshBuilder(false),
      far = new MeshBuilder(false)
    appendClump(near, clump, () => 0, 1, 0.002)
    appendClump(far, clump, () => 0, 0.25, 0.012)
    expect(far.indexCount).toBeLessThan(near.indexCount / 4)
  })

  it('gives every tree picking spheres around its crown', () => {
    const world = createLakeWorld(9182, false)
    const { pick } = prepareVegetation(world, 9182, false)
    expect(pick.length % 4).toBe(0)
    for (const tree of world.trees) {
      // At least one sphere stands over the trunk, above the ground, within the crown's reach.
      let found = false
      for (let i = 0; i < pick.length; i += 4) {
        const dx = (pick[i] ?? 0) - tree.x,
          dz = (pick[i + 2] ?? 0) - tree.z
        const above = (pick[i + 1] ?? 0) - tree.y
        if (Math.hypot(dx, dz) < 1.5 && above > 1 && (pick[i + 3] ?? 0) > 0.2) found = true
      }
      expect(found, `${tree.kind} at ${tree.x},${tree.z}`).toBe(true)
    }
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
      expect(triangles(first)).toBeLessThan(mobile ? 120_000 : 380_000)
      for (let i = 1; i < first.undergrowth.positions.length; i += 3)
        expect(first.undergrowth.positions[i] ?? 0).toBeGreaterThan(WATER_LEVEL)
    }
  }, 30_000)
})
