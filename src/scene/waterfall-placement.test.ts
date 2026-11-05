import { deepStrictEqual } from 'node:assert'

import { describe, expect, it } from 'vitest'

import { required } from '../invariant'
import { lakeIndex, WATER_LEVEL } from './lake-bed'
import { createLakeWorld } from './lake-world'
import { sampleHeight } from './terrain-field'

// Reuse immutable fixture data, while the replay assertion regenerates its own world.
const worlds = new Map<boolean, ReturnType<typeof createLakeWorld>>()
function worldFor(mobile: boolean) {
  let world = worlds.get(mobile)
  if (!world) {
    world = createLakeWorld(1, mobile)
    worlds.set(mobile, world)
  }
  return world
}

describe('procedural waterfall placement', () => {
  it.each([false, true])(
    'keeps a supported source and an unobstructed water landing (mobile=%s)',
    (mobile) => {
      const world = worldFor(mobile)
      const fall = required(world.waterfall)
      const cell = world.field.cell
      const [nx, nz] = fall.direction
      expect(nx * nx + nz * nz).toBe(1)
      expect(fall.top - WATER_LEVEL).toBeGreaterThanOrEqual(1.3)
      expect(fall.top).toBeLessThanOrEqual(2 + 1e-6)
      expect(fall.width).toBeGreaterThanOrEqual(mobile ? 0.7 : 1.5)
      expect(fall.width).toBeLessThanOrEqual(mobile ? 1 : 2)
      expect(fall.x).toBeLessThan(0)
      expect(fall.z).toBeGreaterThanOrEqual(-34)
      expect(fall.z).toBeLessThanOrEqual(-8)
      for (let across = -4; across <= 4; across++) {
        const offset = (fall.width * across) / 8
        const sourceX = fall.x + nz * offset
        const sourceZ = fall.z - nx * offset
        // A sill under the whole sheet, below the pool's surface; the floor at its centre.
        const lip = sampleHeight(world.field, sourceX - nx * 0.04, sourceZ - nz * 0.04)
        expect(lip).toBeLessThan(across === 0 ? fall.top - cell / 2 : fall.top)
        const landing = lakeIndex(world.lakeBed, sourceX + nx * 0.8, sourceZ + nz * 0.8)
        expect(world.lakeBed.water[landing]).toBe(255)
        expect(required(world.lakeBed.obstacle[landing])).toBeLessThan(WATER_LEVEL)
        for (let step = 1; step <= 12; step++) {
          const t = step / 12
          const x = sourceX + nx * 0.8 * t,
            z = sourceZ + nz * 0.8 * t
          const y = fall.top - (fall.top - WATER_LEVEL) * t * t
          expect(sampleHeight(world.field, x, z)).toBeLessThan(y)
        }
      }
    },
  )

  it.each([false, true])('encloses a connected basin on solid ground (mobile=%s)', (mobile) => {
    const world = worldFor(mobile)
    const fall = required(world.waterfall)
    const cell = world.field.cell
    const [nx, nz] = fall.direction
    expect(fall.basin.length).toBeGreaterThan(mobile ? 9 : 19)
    const acrossBasin = fall.basin.map((basin) => basin.x * nz - basin.z * nx)
    expect(Math.max(...acrossBasin) - Math.min(...acrossBasin) + cell).toBeGreaterThan(
      fall.width * 1.4,
    )
    const basinKey = (x: number, z: number) => `${Math.round(x / cell)}:${Math.round(z / cell)}`
    const wetCells = new Set(fall.basin.map((basin) => basinKey(basin.x, basin.z)))
    let floor = Infinity,
      submerged = 0
    for (const basin of fall.basin) {
      expect(basin.size).toBe(cell)
      // The pool's water stands at `top`; its bank may rise through the outermost cells.
      const ground = sampleHeight(world.field, basin.x, basin.z)
      floor = Math.min(floor, ground)
      if (ground < fall.top) submerged++
      expect(world.lakeBed.water[lakeIndex(world.lakeBed, basin.x, basin.z)]).toBe(0)
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const x = basin.x + dx * cell,
          z = basin.z + dz * cell
        if (wetCells.has(basinKey(x, z))) continue
        const ahead = (x - fall.x) * nx + (z - fall.z) * nz
        if (ahead > 0) continue
        // Beside the sheet, the sill continues the lip.
        const side = Math.abs((x - fall.x) * nz - (z - fall.z) * nx)
        if (ahead > -1.5 * cell && side < fall.width / 2 + cell + cell / 2) continue
        // Behind the lip, the bank around the pool holds its water.
        expect(sampleHeight(world.field, x, z), `${x},${z}`).toBeGreaterThan(fall.top)
      }
    }
    expect(floor).toBeCloseTo(fall.top - cell, 1)
    expect(submerged).toBeGreaterThan(fall.basin.length * 0.5)
    const connected = new Set<string>()
    const queue = [required(fall.basin[0])]
    for (let index = 0; index < queue.length; index++) {
      const basin = required(queue[index]),
        key = basinKey(basin.x, basin.z)
      if (connected.has(key)) continue
      connected.add(key)
      for (const neighbor of fall.basin)
        if (
          Math.abs(neighbor.x - basin.x) + Math.abs(neighbor.z - basin.z) < cell + 1e-6 &&
          !connected.has(basinKey(neighbor.x, neighbor.z))
        )
          queue.push(neighbor)
    }
    expect(connected.size).toBe(fall.basin.length)
  })

  it.each([false, true])(
    'reproduces the same source and ground from its seed (mobile=%s)',
    (mobile) => {
      const world = worldFor(mobile)
      const fall = required(world.waterfall)
      const replay = createLakeWorld(1, mobile)
      expect(replay.waterfall).toEqual(fall)
      deepStrictEqual(replay.field.heights, world.field.heights)
    },
  )

  it.each(
    [false, true].flatMap((mobile) =>
      [0, 1, 2, 3, 4, 5, 7, 12, 42, 99, 1234, 9182].map((seed) => ({ mobile, seed })),
    ),
  )('keeps a visible source (mobile=$mobile, seed=$seed)', ({ mobile, seed }) => {
    const fall = required(createLakeWorld(seed, mobile).waterfall)
    expect(fall.x).toBeLessThan(0)
    expect(fall.width).toBeGreaterThanOrEqual(mobile ? 0.7 : 1.5)
    expect(fall.basin.length).toBeGreaterThan(0)
  })
})
