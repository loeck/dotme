import { describe, expect, it } from 'vitest'

import { required } from '../invariant'
import { terrainEyes } from './camera-rig'
import { CHIP_FLOOR_MIN, awaySides, erodeTop, erosionDensity } from './terrain-erosion'
import type { Erosion, ErosionDensity } from './terrain-erosion'
import { exposedVoxelFaces, prepareTerrain } from './voxel-mesh'
import { createVoxelIndex, overlappingVoxels } from './voxel-spatial'
import type { VoxelIndex } from './voxel-spatial'
import { createVoxelWorld } from './voxel-world'
import type { Voxel, VoxelWorld } from './voxel-world'

const cube = (x: number, y: number, z: number, size = 0.25) => ({ x, y, z, size, color: 0x445533 })
const group = (count: number) => ({ positions: new Float32Array(count * 3), count })
const every: ErosionDensity = { chance: 1, deep: 0, fill: 1, rubble: 0 }

function erode(voxels: Voxel[], id: number, density = every, away = 0b1111, eyeHeight = -1) {
  const index = createVoxelIndex(voxels)
  const nearby: number[] = []
  const visible = exposedVoxelFaces(index, id, nearby)
  return {
    index,
    erosion: erodeTop(index, nearby, required(voxels[id]), visible, density, true, away, eyeHeight),
  }
}

/** Every way an eroded voxel can go wrong, as messages, so tests assert without branching. */
function faults(index: VoxelIndex, id: number, voxel: Voxel, erosion: Erosion) {
  const problems: string[] = []
  const { n, cell, depth, through } = erosion
  const s = Math.fround(voxel.size)
  const x0 = Math.fround(voxel.x) - s / 2,
    z0 = Math.fround(voxel.z) - s / 2
  const top = Math.fround(voxel.y) + s / 2
  const visible = exposedVoxelFaces(index, id)
  const others = (box: number[]) => {
    let hit = false
    overlappingVoxels(index, box, (other) => {
      if (other !== id) hit = true
    })
    return hit
  }
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const drop = required(depth[i + j * n])
      if (!drop) continue
      if (i > 0 && i < n - 1 && j > 0 && j < n - 1) problems.push('interior chip')
      if (top - drop < CHIP_FLOOR_MIN) problems.push('floor at the waterline')
      const open = required(through[i + j * n])
      if (!open) problems.push('chip opens nowhere')
      // A chip opens only through visible sides it touches, and only where nothing stands.
      const touches = [i === n - 1, i === 0, j === n - 1, j === 0]
      ;[0, 1, 4, 5].forEach((face, side) => {
        if (!((open >> side) & 1)) return
        if (!touches[side] || !visible[face]) problems.push('opens through a closed side')
      })
      const cx = x0 + i * cell,
        cz = z0 + j * cell
      if (
        others([cx + 1e-4, top - drop + 1e-4, cz + 1e-4, cx + cell - 1e-4, top, cz + cell - 1e-4])
      )
        problems.push('chip under another solid')
    }
  for (const fill of erosion.fills) {
    const lo = fill.center.map((c, a) => c - required(fill.extent[a]) / 2 + 1e-4)
    const hi = fill.center.map((c, a) => c + required(fill.extent[a]) / 2 - 1e-4)
    if (others([...lo, ...hi])) problems.push('fill inside another solid')
    if (Math.abs(required(lo[1]) - 1e-4 - top) > 1e-6) problems.push('fill not on the top')
  }
  return problems
}

/** Rasterises every upward face of a prepared terrain over a voxel's footprint, at 5 mm. */
function uncoveredTop(world: VoxelWorld, voxel: Voxel) {
  const terrain = prepareTerrain(world, [[voxel.x, voxel.y + 20, voxel.z]])
  const s = voxel.size,
    res = 0.005,
    n = Math.round(s / res)
  const covered = new Uint8Array(n * n)
  for (const batch of terrain.batches) {
    if (batch.face !== 2) continue
    const p = batch.positions
    for (let q = 0; q < p.length; q += 12) {
      const xs = [p[q], p[q + 3], p[q + 6], p[q + 9]].map(Number)
      const zs = [p[q + 2], p[q + 5], p[q + 8], p[q + 11]].map(Number)
      const ax = (Math.min(...xs) - (voxel.x - s / 2)) / res,
        bx = (Math.max(...xs) - (voxel.x - s / 2)) / res
      const az = (Math.min(...zs) - (voxel.z - s / 2)) / res,
        bz = (Math.max(...zs) - (voxel.z - s / 2)) / res
      for (let j = Math.max(0, Math.ceil(az - 0.5)); j < Math.min(n, bz - 0.5); j++)
        for (let i = Math.max(0, Math.ceil(ax - 0.5)); i < Math.min(n, bx - 0.5); i++)
          covered[i + j * n] = 1
    }
  }
  return covered.reduce((sum, value) => sum + (value ? 0 : 1), 0)
}

describe('terrain erosion', () => {
  it('chips a step edge only where it drops, and heaps scree where the next step rises', () => {
    // A low step at x = 0, a higher one at x = 0.25 rising from its +x edge, both mid-ground
    // sized and close enough for 6 cm cells; the high step drops away on its other sides.
    const voxels = [cube(0, 1, -4), cube(0.25, 1.25, -4), cube(0.25, 1, -4)]
    const low = erode(voxels, 0)
    const high = erode(voxels, 1)
    for (const [id, { index, erosion }] of [
      [0, low],
      [1, high],
    ] as const) {
      expect(erosion).not.toBeNull()
      expect(faults(index, id, required(voxels[id]), required(erosion))).toEqual([])
    }
    const lowErosion = required(low.erosion)
    // The low step never chips through its +x side, where the high step stands...
    for (let j = 0; j < lowErosion.n; j++) {
      const column = lowErosion.n - 1 + j * lowErosion.n
      expect(required(lowErosion.through[column]) & 1).toBe(0)
    }
    // ...and every scree cell leans on that riser, hiding the face against it.
    expect(lowErosion.fills.length).toBeGreaterThan(0)
    for (const fill of lowErosion.fills) {
      expect(fill.kind).toBe('scree')
      expect(fill.hidden).toContain(0)
      expect(fill.center[0] + fill.extent[0] / 2).toBeCloseTo(0.125, 6)
    }
    // The high step drops on every side, so it chips and heaps no scree.
    expect(required(high.erosion).chips).toBeGreaterThan(0)
    expect(required(high.erosion).fills).toEqual([])
  })

  it('keeps chips off sides facing away from the camera below eye level', () => {
    const voxels = [cube(0, 1, -4)]
    const away = 0b1000 // -z
    const low = required(erode(voxels, 0, every, away, 3).erosion)
    for (const open of low.through) expect(open & away).toBe(0)
    // Above the eyes the same side may open: the slot frames sky, not the lake.
    const high = required(erode(voxels, 0, every, away, 0.5).erosion)
    expect(high.through.some((open) => (open & away) !== 0)).toBe(true)
  })

  it('never joins chips on opposite sides into a slot through the voxel', () => {
    // A lone mid-far voxel splits into 2 × 2 columns: every column touches two sides.
    const voxels = [cube(0, 1, -20)]
    const { erosion } = erode(voxels, 0)
    const { n, depth, through } = required(erosion)
    const slots: string[] = []
    const joins = (a: number, b: number) =>
      depth[a] && depth[b] && !(required(through[a]) & required(through[b]))
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        if (i + 1 < n && joins(i + j * n, i + 1 + j * n)) slots.push(`${i},${j} +x`)
        if (j + 1 < n && joins(i + j * n, i + (j + 1) * n)) slots.push(`${i},${j} +z`)
      }
    expect(required(erosion).chips).toBeGreaterThan(1)
    expect(slots).toEqual([])
  })

  it('meshes an eroded top without gaps', () => {
    const voxels = [cube(0, 1, -4), cube(0.25, 1.25, -4), cube(0.25, 1, -4)]
    const world: VoxelWorld = {
      ...createVoxelWorld(1, false),
      voxels,
      groups: { ground: group(voxels.length), shore: group(0), rock: group(0) },
    }
    const { erosion } = erode(voxels, 1)
    expect(required(erosion).chips).toBeGreaterThan(0)
    // The meshed top must itself be eroded, or a gap-free result would prove nothing.
    const top = required(voxels[1])
    expect(prepareTerrain(world, [[top.x, top.y + 20, top.z]]).chips).toBeGreaterThan(0)
    expect(uncoveredTop(world, top)).toBe(0)
  })

  it.each([false, true])(
    'stays clear of other solids across a whole world (mobile: %s)',
    (mobile) => {
      const world = createVoxelWorld(9182, mobile)
      const index = createVoxelIndex(world.voxels)
      const eyes = terrainEyes().filter(([, y, z]) => y > 0 && z > 15)
      const nearest = [0, 1, 2].map((a) => Math.min(...eyes.map((eye) => required(eye[a]))))
      const farthest = [0, 1, 2].map((a) => Math.max(...eyes.map((eye) => required(eye[a]))))
      const problems = new Set<string>()
      let chips = 0,
        fills = 0
      const nearby: number[] = []
      world.voxels.forEach((voxel, id) => {
        const visible = exposedVoxelFaces(index, id, nearby)
        const erosion = erodeTop(
          index,
          nearby,
          voxel,
          visible,
          erosionDensity(voxel.size, voxel.z, !mobile, id >= world.groups.ground.count),
          !mobile,
          awaySides(voxel, nearest, farthest),
          required(farthest[1]),
        )
        if (!erosion) return
        chips += erosion.chips
        fills += erosion.fills.length
        for (const problem of faults(index, id, voxel, erosion)) problems.add(problem)
      })
      expect([...problems]).toEqual([])
      expect(chips).toBeGreaterThan(mobile ? 2000 : 30_000)
      expect(fills).toBeGreaterThan(mobile ? 500 : 10_000)
    },
    120_000,
  )
})
