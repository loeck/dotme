import { describe, expect, it } from 'vitest'

import { required } from '../invariant'
import { createPhysicsWorld, loadPhysics } from './physics-world'
import type { PhysicsWorld } from './physics-world'
import {
  DEFAULT_RAIN,
  IMPACT_LIFETIME,
  RAIN_STEP,
  RainSimulation,
  WATER_Y,
} from './rain-simulation'
import type { SegmentTrace } from './rain-simulation'
import { createVoxelIndex } from './voxel-spatial'
import type { Voxel } from './voxel-world'

const empty = (): SegmentTrace => () => Infinity
const shelter = async (voxels: Voxel[]): Promise<PhysicsWorld> =>
  createPhysicsWorld(await loadPhysics(), createVoxelIndex(voxels))
const wavySurface = (x: number, z: number, time: number) =>
  WATER_Y + 0.11 * Math.sin(x * 2.3 + z * 1.1 + time * 3.7 + 0.8)
const dropAt = (simulation: RainSimulation, y: number, size = 0.003) => {
  const drop = required(simulation.drops[0])
  Object.assign(drop, { x: 0, y, z: 0, vx: 2, vy: -6, vz: 0.5, size, seed: 0.2, alive: true })
  return drop
}

describe('rain collision and impact lifecycle', () => {
  it('removes a drop and creates one impact at the interpolated water crossing', () => {
    const simulation = new RainSimulation(empty(), true, 42)
    simulation.setRainState({ ...DEFAULT_RAIN, intensity: 0.001 })
    const drop = dropAt(simulation, WATER_Y + 0.025)
    simulation.update(RAIN_STEP)
    expect(drop.alive).toBe(false)
    const impacts = simulation.impacts.filter((impact) => Number.isFinite(impact.born))
    expect(impacts).toHaveLength(1)
    expect(required(impacts[0]).x).toBeCloseTo((2 * 0.025) / 6)
    expect(required(impacts[0]).z).toBeCloseTo((0.5 * 0.025) / 6)
    expect(required(impacts[0]).y).toBe(WATER_Y)
    expect(required(impacts[0]).born).toBeCloseTo(0.025 / 6)
    simulation.update(RAIN_STEP)
    expect(simulation.impacts.filter((impact) => Number.isFinite(impact.born))).toHaveLength(1)
  })

  it('lets voxels shelter the lake while deep solids keep the water contact', async () => {
    await Promise.all(
      [0, -3].map(async (y) => {
        const physics = await shelter([{ x: 0, y, z: 0, size: 0.01, color: 0 }])
        try {
          const simulation = new RainSimulation((a, b) => physics.trace(a, b), true, 4)
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
        } finally {
          physics.dispose()
        }
      }),
    )
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
    const large = required(simulation.drops[1])
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
    const available = required(simulation.drops.at(-1))
    available.alive = false
    simulation.update(RAIN_STEP)
    expect(available.alive).toBe(true)
    expect(available.y).toBeGreaterThan(21)
    expect(simulation.drops.every((drop) => drop.alive)).toBe(true)
  })
})

describe('rain contacts on moving water', () => {
  it('keeps one shared contact on the moving surface at every display refresh rate', () => {
    const results = [10, 30, 60, 120, 144].map((fps) => {
      const simulation = new RainSimulation(empty(), true, 42)
      simulation.setRainState({ ...DEFAULT_RAIN, intensity: 0.00001 })
      simulation.setWaterSurface(wavySurface)
      const drop = dropAt(simulation, 0.14)
      for (let frame = 0; frame < fps; frame++) simulation.update(1 / fps)
      expect(drop.alive).toBe(false)
      const impacts = simulation.impacts.filter((impact) => Number.isFinite(impact.born))
      expect(impacts).toHaveLength(1)
      const impact = required(impacts[0])
      expect(impact.born).toBeGreaterThan(0)
      expect(impact.born).toBeLessThan((0.14 - WATER_Y) / 6)
      expect(impact.y).toBe(wavySurface(impact.x, impact.z, impact.born))
      expect(impact.y).toBeCloseTo(0.14 - 6 * impact.born, 6)
      expect(impact.x).toBeCloseTo(2 * impact.born, 10)
      expect(impact.z).toBeCloseTo(0.5 * impact.born, 10)
      expect(impact.vy).toBe(-6)
      return impact
    })
    for (const impact of results.slice(1)) expect(impact).toEqual(results[0])
  })

  it('resolves the first water or solid contact, including rocks exposed by a trough', async () => {
    const fixtures = [
      { water: 0.12, block: 0.04, start: 0.16, impacts: 1 },
      { water: -0.15, block: -0.07, start: 0, impacts: 0 },
      { water: 0.12, block: 0.16, start: 0.2, impacts: 0 },
    ]
    await Promise.all(
      fixtures.map(async (fixture) => {
        const physics = await shelter([{ x: 0, y: fixture.block, z: 0, size: 0.04, color: 0 }])
        try {
          const simulation = new RainSimulation((a, b) => physics.trace(a, b), true, 42)
          simulation.setRainState({ intensity: 0.00001, wind: { x: 0, z: 0 } })
          simulation.setWaterSurface(() => fixture.water)
          const drop = dropAt(simulation, fixture.start)
          Object.assign(drop, { vx: 0, vz: 0, vy: -24 })
          simulation.update(RAIN_STEP)
          expect(drop.alive).toBe(false)
          const impacts = simulation.impacts.filter((impact) => Number.isFinite(impact.born))
          expect(impacts).toHaveLength(fixture.impacts)
          expect(impacts.map((impact) => impact.y)).toEqual(
            Array.from({ length: fixture.impacts }, () => fixture.water),
          )
        } finally {
          physics.dispose()
        }
      }),
    )
  })

  it('skips spectrum samples above the lake and restores flat-water behavior when detached', () => {
    const simulation = new RainSimulation(empty(), true, 42)
    simulation.setRainState({ ...DEFAULT_RAIN, intensity: 0.00001 })
    let calls = 0
    simulation.setWaterSurface(() => {
      calls++
      return 0.15
    })
    dropAt(simulation, 2)
    simulation.update(RAIN_STEP)
    expect(calls).toBe(0)
    simulation.setWaterSurface()
    dropAt(simulation, WATER_Y + 0.025)
    simulation.update(RAIN_STEP)
    const impact = required(simulation.impacts.find((value) => Number.isFinite(value.born)))
    expect(impact.y).toBe(WATER_Y)
    expect(impact.vy).toBe(-6)
    expect(calls).toBe(0)
  })

  it('does not prime airborne drops below a wave crest', () => {
    const simulation = new RainSimulation(empty(), true, 42)
    simulation.setWaterSurface(() => 0.18)
    simulation.prime()
    const alive = simulation.drops.filter((drop) => drop.alive)
    expect(alive.length).toBeGreaterThan(100)
    expect(alive.every((drop) => drop.y > 0.18)).toBe(true)
    expect(simulation.impacts.every((impact) => !Number.isFinite(impact.born))).toBe(true)
  })
})
