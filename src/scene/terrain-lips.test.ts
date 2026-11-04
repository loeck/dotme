import { describe, expect, it } from 'vitest'

import { required } from '../invariant'
import { lipCellSize, lipCells } from './terrain-lips'
import type { LipCell } from './terrain-lips'
import { exposedVoxelFaces } from './voxel-mesh'
import { createVoxelIndex, overlappingVoxels } from './voxel-spatial'
import type { VoxelIndex } from './voxel-spatial'
import { createVoxelWorld } from './voxel-world'
import type { Voxel } from './voxel-world'

const cube = (x: number, y: number, z: number, size = 0.25) => ({ x, y, z, size, color: 0x445533 })
const bounds = (cell: LipCell) => ({
  lo: cell.center.map((c, a) => c - required(cell.extent[a]) / 2),
  hi: cell.center.map((c, a) => c + required(cell.extent[a]) / 2),
})

/** Every way a cell can go wrong, as a list of messages, so tests assert without branching. */
function faults(index: VoxelIndex, id: number, voxel: Voxel, cell: LipCell) {
  const problems: string[] = []
  const { lo, hi } = bounds(cell)
  const half = voxel.size / 2
  const parent = [voxel.x, voxel.y, voxel.z].map((c): [number, number] => [c - half, c + half])
  for (let a = 0; a < 3; a++) {
    const [p0, p1] = required(parent[a])
    if (required(hi[a]) < p0 - 1e-6 || required(lo[a]) > p1 + 1e-6) problems.push('detached')
  }
  const m = lipCellSize(voxel.size, voxel.z)
  if (cell.extent.some((e) => e > m * 1.2 + 1e-6)) problems.push('oversized')
  // The part beyond the parent along the overhang axis meets no other voxel.
  const shrink = 2e-4
  const outside = [...lo.map((v) => v + shrink), ...hi.map((v) => v - shrink)]
  for (const a of [0, 2]) {
    const [p0, p1] = required(parent[a])
    if (required(hi[a]) > p1 + 1e-4) outside[a] = p1 + shrink
    else if (required(lo[a]) < p0 - 1e-4) outside[a + 3] = p0 - shrink
  }
  if (cell.kind === 'turf')
    overlappingVoxels(index, outside, (hit) => {
      if (hit !== id) problems.push('intersects')
    })
  return problems
}

describe('terrain lip cells', () => {
  it('hangs turf over a drop and rests stones against the next riser', () => {
    // A low step at x = 0 and a higher one at x = 0.25 rising from its +x edge, both mid-ground
    // sized and close enough for 6 cm cells.
    const voxels = [cube(0, 1, -4), cube(0.25, 1.25, -4), cube(0.25, 1, -4)]
    const index = createVoxelIndex(voxels)
    const cells = [0, 1].flatMap((id) =>
      lipCells(index, id, required(voxels[id]), exposedVoxelFaces(index, id)).map((cell) => ({
        id,
        cell,
      })),
    )
    const problems = cells.flatMap(({ id, cell }) => faults(index, id, required(voxels[id]), cell))
    expect(problems).toEqual([])
    const turf = cells.filter(({ cell }) => cell.kind === 'turf')
    expect(turf.length).toBeGreaterThan(0)
    // Turf hanging from the high step over the low one stays above the low step's top.
    const overLow = turf
      .filter(({ id }) => id === 1)
      .map(({ cell }) => bounds(cell))
      .filter(({ lo }) => required(lo[0]) < 0.125)
    expect(overLow.every(({ lo }) => required(lo[1]) > 1.125)).toBe(true)
    // The low step's turf never overhangs the riser that rises from it.
    const lowTurf = turf.filter(({ id }) => id === 0).map(({ cell }) => bounds(cell))
    expect(lowTurf.every(({ hi }) => required(hi[0]) <= 0.125 + 1e-6)).toBe(true)
    // Stones sit on the low step's top, against the high step's riser.
    const stones = cells
      .filter(({ cell }) => cell.kind === 'pebble')
      .map(({ cell }) => bounds(cell))
    expect(stones.every(({ lo, hi }) => required(lo[1]) < 1.125 && required(hi[1]) > 1.125)).toBe(
      true,
    )
    expect(stones.every(({ hi }) => Math.abs(required(hi[0]) - 0.125) < 1e-6)).toBe(true)
  })

  it.each([false, true])(
    'stays attached and clear of other solids (mobile: %s)',
    (mobile) => {
      const world = createVoxelWorld(9182, mobile)
      const index = createVoxelIndex(world.voxels)
      let count = 0
      const problems = new Set<string>()
      for (let id = 0; id < world.groups.ground.count; id++) {
        const voxel = required(world.voxels[id])
        for (const cell of lipCells(index, id, voxel, exposedVoxelFaces(index, id), !mobile)) {
          count++
          for (const problem of faults(index, id, voxel, cell)) problems.add(problem)
        }
      }
      expect([...problems]).toEqual([])
      expect(count).toBeGreaterThan(mobile ? 100 : 5000)
      expect(count).toBeLessThan(mobile ? 2000 : 30000)
    },
    60_000,
  )
})
