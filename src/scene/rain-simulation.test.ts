import { describe, expect, it } from 'vitest'

import {
  DEFAULT_RAIN,
  IMPACT_LIFETIME,
  queryRainState,
  RAIN_STEP,
  RainCollider,
  RainSimulation,
  WATER_Y,
} from './rain-simulation'
import { createVoxelIndex } from './voxel-spatial'

const empty = () => new RainCollider([])
const dropAt = (simulation: RainSimulation, y: number, size = 0.003) => {
  const drop = simulation.drops[0]!
  Object.assign(drop, { x: 0, y, z: 0, vx: 2, vy: -6, vz: 0.5, size, seed: 0.2, alive: true })
  return drop
}

describe('temporary rain initialization', () => {
  it('uses presets, bounded numbers, and defaults for invalid inputs', () => {
    for (const [preset, intensity] of [
      ['off', 0],
      ['light', 0.25],
      ['moderate', 0.55],
      ['heavy', 1],
    ] as const)
      expect(queryRainState(`?rain=${preset}`).intensity).toBe(intensity)
    expect(queryRainState('')).toEqual(DEFAULT_RAIN)
    expect(queryRainState('?rain=0.4&windX=-3&windZ=0')).toEqual({
      intensity: 0.4,
      wind: { x: -3, z: 0 },
    })
    expect(queryRainState('?rain=2&windX=-100&windZ=100')).toEqual({
      intensity: 1,
      wind: { x: -20, z: 20 },
    })
    expect(queryRainState('?rain=-2').intensity).toBe(0)
    for (const value of ['NaN', 'Infinity', 'invalid', '', 'constructor', 'toString'])
      expect(queryRainState(`?rain=${value}&windX=${value}&windZ=${value}`)).toEqual(DEFAULT_RAIN)
  })
})

describe('rain collision and impact lifecycle', () => {
  it('intercepts a fast diagonal segment at the first voxel, including thin roofs', () => {
    const collider = new RainCollider([
      { x: 0, y: 2, z: 0, size: 0.1, color: 0 },
      { x: 0, y: 1, z: 0, size: 0.1, color: 0 },
    ])
    expect(collider.trace({ x: 0, y: 3, z: 0 }, { x: 0, y: -2, z: 0 })).toBeCloseTo(0.19)
    expect(collider.trace({ x: -1, y: 3, z: 0 }, { x: 1, y: 1, z: 0 })).toBeCloseTo(0.475)
    expect(collider.trace({ x: 0, y: 2, z: 0 }, { x: 2, y: 2, z: 0 })).toBe(0)
    expect(collider.trace({ x: 1, y: 3, z: 0 }, { x: 1, y: -2, z: 0 })).toBe(Infinity)
  })

  it('removes a drop and creates one impact at the interpolated water crossing', () => {
    const simulation = new RainSimulation(empty(), true, 42)
    simulation.setRainState({ ...DEFAULT_RAIN, intensity: 0.001 })
    const drop = dropAt(simulation, WATER_Y + 0.025)
    simulation.update(RAIN_STEP)
    expect(drop.alive).toBe(false)
    const impacts = simulation.impacts.filter((impact) => Number.isFinite(impact.born))
    expect(impacts).toHaveLength(1)
    expect(impacts[0]!.x).toBeCloseTo((2 * 0.025) / 6)
    expect(impacts[0]!.z).toBeCloseTo((0.5 * 0.025) / 6)
    expect(impacts[0]!.y).toBe(WATER_Y)
    expect(impacts[0]!.born).toBeCloseTo(0.025 / 6)
    simulation.update(RAIN_STEP)
    expect(simulation.impacts.filter((impact) => Number.isFinite(impact.born))).toHaveLength(1)
  })

  it('lets voxels shelter the lake and ignores submerged obstacles', () => {
    for (const y of [0, -3]) {
      const simulation = new RainSimulation(
        new RainCollider([{ x: 0, y, z: 0, size: 0.01, color: 0 }]),
        true,
        4,
      )
      simulation.setRainState({ ...DEFAULT_RAIN, intensity: 0.001, wind: { x: 0, z: 0 } })
      const drop = dropAt(simulation, 0.02)
      drop.vx = 0
      drop.vz = 0
      drop.vy = -10
      simulation.update(RAIN_STEP)
      expect(drop.alive).toBe(false)
      expect(simulation.impacts.filter((impact) => Number.isFinite(impact.born))).toHaveLength(
        y === 0 ? 0 : 1,
      )
    }
  })

  it('stops immediately and clears impact history when disabled', () => {
    const simulation = new RainSimulation(empty(), true, 1)
    simulation.prime()
    simulation.update(0.05)
    simulation.setRainState({ ...DEFAULT_RAIN, intensity: 0 })
    const time = simulation.time
    simulation.update(100)
    expect(simulation.time).toBe(time)
    expect(simulation.drops.some((drop) => drop.alive)).toBe(false)
    expect(
      simulation.impacts.some((impact) => simulation.time - impact.born < IMPACT_LIFETIME),
    ).toBe(false)
  })
})

describe('rain timing, wind and budgets', () => {
  it('produces the same trajectories and impacts across refresh rates and a wind change', () => {
    const results = [10, 15, 30, 60, 120, 144].map((fps) => {
      const simulation = new RainSimulation(empty(), true, 42)
      simulation.prime()
      for (let frame = 0; frame < fps * 2; frame++) {
        if (frame === fps) simulation.setRainState({ intensity: 0.55, wind: { x: -5, z: 3 } })
        simulation.update(1 / fps)
      }
      return { time: simulation.time, drops: simulation.drops, impacts: simulation.impacts }
    })
    for (const result of results.slice(1)) expect(result).toEqual(results[0])
  })

  it('makes smaller drops follow a new wind faster without teleporting', () => {
    const simulation = new RainSimulation(empty(), true, 1)
    simulation.setRainState({ intensity: 0.001, wind: { x: 8, z: -2 } })
    const small = dropAt(simulation, 10, 0.0006)
    const large = simulation.drops[1]!
    Object.assign(large, small, { size: 0.0044 })
    simulation.update(0.05)
    expect(small.vx).toBeGreaterThan(large.vx)
    expect(small.vx).toBeLessThan(8)
    expect(small.vz).toBeLessThan(large.vz)
    expect(small.x).toBeGreaterThan(large.x)
    expect(small.x).toBeLessThan(8 * 0.05)
  })

  it('bounds catch-up, ignores invalid deltas and retains fixed pool sizes', () => {
    const simulation = new RainSimulation(empty(), true, 1)
    simulation.update(NaN)
    simulation.update(-1)
    expect(simulation.time).toBe(0)
    simulation.update(10)
    expect(simulation.time).toBeCloseTo(0.1)
    simulation.setRainState({ intensity: 1, wind: { x: 20, z: -20 } })
    for (let i = 0; i < 200; i++) simulation.update(0.05)
    expect(simulation.drops).toHaveLength(4000)
    expect(simulation.impacts).toHaveLength(2400)
    const desktop = new RainSimulation(empty(), false, 1)
    expect(desktop.drops.length).toBeGreaterThan(simulation.drops.length)
    expect(simulation.drops.every((drop) => Number.isFinite(drop.x))).toBe(true)
  })

  it('increases frequency without inflating the drop-size distribution', () => {
    const counts: number[] = []
    for (const intensity of [0.25, 0.55, 1]) {
      const simulation = new RainSimulation(empty(), false, 42)
      simulation.setRainState({ ...DEFAULT_RAIN, intensity })
      for (let i = 0; i < 20; i++) simulation.update(0.05)
      const drops = simulation.drops.filter((drop) => drop.alive)
      counts.push(drops.length)
      expect(drops.filter((drop) => drop.size < 0.002).length / drops.length).toBeGreaterThan(0.6)
      expect(drops.every((drop) => drop.size >= 0.0006 && drop.size <= 0.0044)).toBe(true)
    }
    expect(counts[0]).toBeCloseTo(1050, 0)
    expect(counts[1]).toBeCloseTo(2310, 0)
    expect(counts[2]).toBeCloseTo(4200, 0)
  })

  it('reuses available slots even when the emission cursor points at live drops', () => {
    const simulation = new RainSimulation(empty(), true, 42)
    simulation.setRainState({ ...DEFAULT_RAIN, intensity: 1 })
    for (const drop of simulation.drops)
      Object.assign(drop, { alive: true, y: 10, vy: -7, size: 0.001 })
    const available = simulation.drops.at(-1)!
    available.alive = false
    simulation.update(RAIN_STEP)
    expect(available.alive).toBe(true)
    expect(available.y).toBeGreaterThan(21)
    expect(simulation.drops.every((drop) => drop.alive)).toBe(true)
  })
})

describe('rain collisions against the transferred terrain index', () => {
  it('matches voxel buckets for inside starts, misses, submerged solids and oblique segments', () => {
    const voxels = [
      { x: 0, y: 2, z: 0, size: 0.125, color: 0 },
      { x: 0, y: 1, z: 0, size: 0.5, color: 0 },
      { x: 0, y: -3, z: 0, size: 0.5, color: 0 },
    ]
    const reference = new RainCollider(voxels)
    const indexed = new RainCollider(createVoxelIndex(voxels))
    for (let i = 0; i < 300; i++) {
      const a = { x: Math.sin(i) * 0.3, y: i % 3 === 0 ? 1 : 3, z: Math.cos(i) * 0.2 }
      const b = { x: Math.cos(i) * 0.5, y: -4, z: Math.sin(i) * 0.5 }
      expect(indexed.trace(a, b)).toBe(reference.trace(a, b))
    }
    expect(indexed.trace({ x: 0, y: -2, z: 0 }, { x: 0, y: -4, z: 0 })).toBe(Infinity)
    expect(indexed.trace({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 })).toBe(0)
    expect(indexed.trace({ x: 5, y: 3, z: 0 }, { x: 5, y: -4, z: 0 })).toBe(Infinity)
  })
})

it('conservative columns never discard cell-boundary, empty-column or long-segment hits', () => {
  const voxels = Array.from({ length: 64 }, (_, i) => ({
    x: ((i % 8) - 4) * 2,
    y: i % 5,
    z: (Math.floor(i / 8) - 4) * 2,
    size: i % 3 === 0 ? 0.125 : 1,
    color: 0,
  }))
  const reference = new RainCollider(voxels)
  const indexed = new RainCollider(createVoxelIndex(voxels))
  for (let i = 0; i < 2000; i++) {
    const a = { x: Math.sin(i * 7) * 12, y: (i % 8) - 1, z: Math.cos(i * 3) * 12 }
    const b = { x: Math.cos(i * 5) * 12, y: -2, z: Math.sin(i * 11) * 12 }
    expect(indexed.trace(a, b)).toBe(reference.trace(a, b))
  }
  for (const voxel of voxels) {
    const a = { x: voxel.x, y: 20, z: voxel.z },
      b = { ...a, y: -2 }
    expect(indexed.trace(a, b)).toBe(reference.trace(a, b))
    a.x += voxel.size / 2
    b.x = a.x
    expect(indexed.trace(a, b)).toBe(reference.trace(a, b))
  }
  expect(
    new RainCollider(createVoxelIndex([])).trace({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 }),
  ).toBe(Infinity)
})
