import { Matrix4, Scene, Vector3, Vector4 } from 'three'
import { describe, expect, it } from 'vitest'

import { required } from '../invariant'
import { FloatingBodies } from './floating-bodies'
import { createLakeBed, WATER_LEVEL } from './lake-bed'
import { LakeSplashes } from './lake-splashes'
import { createPhysicsWorld, loadPhysics } from './physics-world'
import { createVoxelIndex } from './voxel-spatial'
import type { Voxel } from './voxel-world'
import { WaterContact } from './water-contact'
import { sampleWindField } from './water-surface'
import { WindModel } from './wind'

const block: Voxel = { x: 0, y: 0.5, z: 0, size: 4, color: 0 }
const bed = createLakeBed([block], 42, true)
const windy = new WindModel(42, { meanSpeed: 8, bearing: 0, gustStrength: 0, turnStrength: 0 })

const physicsFor = async () => createPhysicsWorld(await loadPhysics(), createVoxelIndex([block]))

const positionsOf = (floating: FloatingBodies) => {
  const matrix = new Matrix4(),
    position = new Vector3()
  return Array.from({ length: floating.mesh.count }, (_, i) => {
    floating.mesh.getMatrixAt(i, matrix)
    return position.setFromMatrixPosition(matrix).toArray()
  })
}

const run = async (seed: number, frames = 600) => {
  const physics = await physicsFor()
  const scene = new Scene()
  const splashes = new LakeSplashes(scene, bed, seed, true, physics)
  const floating = new FloatingBodies(scene, bed, seed, true, physics, splashes)
  const contact = new WaterContact(bed)
  splashes.setWaterContact(contact)
  floating.setWaterContact(contact)
  try {
    const wakes: number[][] = []
    floating.onWake = (...event) => wakes.push(event)
    const start = positionsOf(floating)
    for (let frame = 0; frame < frames; frame++) {
      const time = frame / 60
      const wind = windy.sample(time)
      floating.update(time, wind)
      splashes.update(time, wind)
    }
    return { start, end: positionsOf(floating), wakes }
  } finally {
    floating.dispose()
    splashes.dispose()
    physics.dispose()
    expect(scene.children).toHaveLength(0)
  }
}

describe('floating bodies', () => {
  it('reports a waterline circle for floaters resting on the surface', async () => {
    const physics = await physicsFor()
    const scene = new Scene()
    const splashes = new LakeSplashes(scene, bed, 42, true, physics)
    const floating = new FloatingBodies(scene, bed, 42, true, physics, splashes)
    try {
      for (let frame = 0; frame < 240; frame++) {
        const time = frame / 60
        floating.update(time, windy.sample(time))
        splashes.update(time, windy.sample(time))
      }
      const slots = Array.from({ length: 8 }, () => new Vector4())
      floating.waterlines(slots)
      const [buoy] = slots
      expect(required(buoy).w).toBe(1)
      expect(required(buoy).z).toBeGreaterThan(0.03)
      expect(required(buoy).z).toBeLessThanOrEqual(0.09)
      expect(required(slots.at(-1)).toArray()).toEqual([0, 0, 0, 0])
    } finally {
      floating.dispose()
      splashes.dispose()
      physics.dispose()
    }
  })

  it('only receives an immediate shove when the click reaches its hull', async () => {
    const physics = await physicsFor()
    const scene = new Scene()
    const splashes = new LakeSplashes(scene, bed, 42, true, physics)
    const floating = new FloatingBodies(scene, bed, 42, true, physics, splashes)
    try {
      const [buoy] = positionsOf(floating)
      const [bx, , bz] = required(buoy)
      floating.splash(bx - 1.5, bz, 0.55)
      physics.world.step()
      floating.update(0, windy.sample(0), false)
      const [afterFarClick] = positionsOf(floating)
      expect(required(afterFarClick)[0]).toBeCloseTo(bx, 6)

      floating.splash(bx - 0.1, bz, 0.55)
      physics.world.step()
      floating.update(0, windy.sample(0), false)
      const [after] = positionsOf(floating)
      expect(required(after)[0]).toBeGreaterThan(bx)
    } finally {
      floating.dispose()
      splashes.dispose()
      physics.dispose()
    }
  })

  it('rides the surface and drifts downwind without sinking', async () => {
    const { start, end, wakes } = await run(42)
    expect(end.length).toBeGreaterThan(0)
    const time = 599 / 60,
      wind = windy.sample(time)
    for (const [i, position] of end.entries()) {
      const [x, y, z] = [required(position[0]), required(position[1]), required(position[2])]
      expect(Number.isFinite(x + y + z)).toBe(true)
      const surface = WATER_LEVEL + sampleWindField(x, z, time, wind, 0.08)[0]
      expect(Math.abs(y - surface)).toBeLessThan(0.35)
      const from = required(start[i])
      expect(Math.hypot(x - required(from[0]), z - required(from[2]))).toBeGreaterThan(0.05)
    }
    const buoy = required(end[0]),
      buoyStart = required(start[0])
    expect(required(buoy[0])).toBeGreaterThan(required(buoyStart[0]))
    expect(wakes.length).toBeGreaterThan(0)
    expect(wakes.length).toBeLessThan(100)
    expect(
      wakes.every(
        ([x, z, radius, velocity]) =>
          Number.isFinite(required(x) + required(z)) &&
          required(radius) > 0 &&
          required(velocity) < 0,
      ),
    ).toBe(true)
  })

  it('replays the same trajectory deterministically', async () => {
    const first = await run(42)
    expect(await run(42)).toEqual(first)
    expect((await run(43)).end).not.toEqual(first.end)
  })
})
