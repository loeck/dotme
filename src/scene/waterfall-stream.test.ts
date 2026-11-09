import { describe, expect, it } from 'vitest'

import { required } from '../invariant'
import { createLakeWorld } from './lake-world'
import { sampleHeight } from './terrain-field'
import { STREAM_BANK_REACH, STREAM_CLEARANCE } from './waterfall-stream'

const SEEDS = [42, 1, 9182, 2024]
const MANY = Array.from({ length: 30 }, (_, i) => (Math.imul(i + 1, 0x9e3779b1) >>> 0) % 100_000)

function checkStream(seed: number, mobile: boolean) {
  const world = createLakeWorld(seed, mobile)
  const fall = required(world.waterfall)
  const { points, width } = fall.stream
  const inPool = (x: number, z: number) =>
    fall.basin.some(
      (cell) =>
        Math.abs(x - cell.x) <= cell.size / 2 + 1e-6 &&
        Math.abs(z - cell.z) <= cell.size / 2 + 1e-6,
    )
  expect(width).toBeGreaterThan(0.3)
  // Connected: the course ends inside the pool, at its surface.
  const mouth = required(points.at(-1))
  expect(mouth.y).toBe(fall.top)
  expect(inPool(mouth.x, mouth.z)).toBe(true)
  for (let i = 1; i < points.length; i++) {
    const a = required(points[i - 1]),
      b = required(points[i])
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThan(world.field.cell * 1.5)
    // Downhill towards the pool.
    expect(b.y).toBeLessThanOrEqual(a.y + 1e-9)
  }
  // Every ribbon section lies over its bed and between banks that stand above the water, so
  // no ribbon vertex shows through or above the ground.
  points.forEach((point, i) => {
    const label = `seed ${seed} point ${i} of ${points.length}`
    const ground = sampleHeight(world.field, point.x, point.z)
    expect({ label, bed: ground < point.y - STREAM_CLEARANCE + 1e-6 }).toEqual({ label, bed: true })
    expect({ label, depth: ground > point.y - 0.5 }).toEqual({ label, depth: true })
    if (inPool(point.x, point.z)) return
    const before = points[Math.max(0, i - 1)] ?? point,
      after = points[Math.min(points.length - 1, i + 1)] ?? point
    const dx = after.x - before.x,
      dz = after.z - before.z
    const span = Math.hypot(dx, dz) || 1
    const reach = width / 2 + STREAM_BANK_REACH
    for (const side of [-1, 1]) {
      const x = point.x + (dz / span) * reach * side,
        z = point.z - (dx / span) * reach * side
      if (inPool(x, z)) continue
      expect(sampleHeight(world.field, x, z), `${label} side ${side}`).toBeGreaterThan(
        point.y + STREAM_CLEARANCE - 1e-6,
      )
    }
  })
  // Where the ribbon shows, the camera's line of sight clears the ground in front of it.
  for (const point of points) {
    if (point.shown === 0) continue
    const distance = Math.hypot(point.x, point.z - 16)
    for (let k = 1; k < distance / 0.1; k++) {
      const t = (k * 0.1) / distance
      const x = point.x * t,
        z = 16 + (point.z - 16) * t
      if (points.some((other) => Math.hypot(other.x - x, other.z - z) < width / 2 + 0.45)) continue
      expect(sampleHeight(world.field, x, z), `seed ${seed} sight`).toBeLessThan(
        2.5 + (point.y - 2.5) * t,
      )
    }
  }
  return { fall, points }
}

describe('waterfall stream', () => {
  it.each(SEEDS.flatMap((seed) => [false, true].map((mobile) => [seed, mobile] as const)))(
    'feeds the pool from higher ground, downhill and in its channel (seed %i, mobile=%s)',
    (seed, mobile) => {
      const { fall, points } = checkStream(seed, mobile)
      expect(points.length).toBeGreaterThanOrEqual(4)
      const [nx, nz] = fall.direction
      const spring = required(points[0])
      expect((spring.x - fall.x) * nx + (spring.z - fall.z) * nz).toBeLessThan(-1)
      expect(spring.y).toBeGreaterThan(fall.top + 0.15)
    },
  )

  it('stays in its carved channel on many seeds', { timeout: 120_000 }, () => {
    let long = 0,
      seen = 0
    for (const seed of MANY) {
      const { points } = checkStream(seed, false)
      if (points.length >= 8) long++
      if (points.some((point) => point.shown === 1)) seen++
    }
    // Nearly every stream keeps a carved length above the pool, and most show some water.
    expect(long).toBeGreaterThanOrEqual(MANY.length * 0.8)
    expect(seen).toBeGreaterThanOrEqual(MANY.length * 0.6)
  })

  it('is deterministic per seed', () => {
    const a = required(createLakeWorld(2024, false).waterfall).stream
    const b = required(createLakeWorld(2024, false).waterfall).stream
    expect(b).toEqual(a)
    const other = required(createLakeWorld(42, false).waterfall).stream
    expect(other).not.toEqual(a)
  })
})
