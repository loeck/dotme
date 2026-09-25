import { Matrix4, Scene, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { required } from '../invariant'
import { FloatingBodies } from './floating-bodies'
import { createLakeBed, WATER_LEVEL } from './lake-bed'
import { LakeSplashes } from './lake-splashes'
import { createPhysicsWorld, loadPhysics } from './physics-world'
import { createVoxelIndex } from './voxel-spatial'
import type { Voxel } from './voxel-world'
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
