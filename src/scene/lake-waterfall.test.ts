import {
  Scene,
  Mesh,
  BufferGeometry,
  BufferAttribute,
  InstancedBufferAttribute,
} from 'three/webgpu'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import { createLakeBed } from './lake-bed'
import { LakeSplashes } from './lake-splashes'
import type { SplashJet } from './lake-splashes'
import { LakeWaterfall } from './lake-waterfall'
import { createPhysicsWorld, loadPhysics } from './physics-world'
import { createVoxelIndex } from './voxel-spatial'
import type { Voxel, VoxelWaterfall } from './voxel-world'
import { WindModel } from './wind'
import type { WindState } from './wind'

afterEach(() => vi.restoreAllMocks())

const fall = {
  x: -22,
  z: -18,
  top: 3,
  width: 1.2,
  seed: 42,
  direction: [1, 0],
  basin: [
    { x: -22.53, z: -18, size: 1 },
    { x: -23.53, z: -18, size: 1 },
  ],
} satisfies VoxelWaterfall

const steadyWind: WindState = {
  direction: [1, 0],
  speed: 2,
  displacement: [0, 0],
  rotation: [0, 0],
  rotationVelocity: 0,
  response: [0, 0, 0, 0],
}

const physicsFor = async (voxels: Voxel[] = []) =>
  createPhysicsWorld(await loadPhysics(), createVoxelIndex(voxels))

const streamed = (waterfall: LakeWaterfall, name: string) => {
  const found = waterfall.curtain.geometry.getAttribute(name)
  if (!(found instanceof InstancedBufferAttribute)) throw new Error(`Missing ${name}`)
  if (!(found.array instanceof Float32Array)) throw new Error(`Missing ${name} data`)
  return found.array
}

describe('lake waterfall lifecycle', () => {
  it('emits only when falling parcels reach the lake, without a suspended-time burst', async () => {
    const scene = new Scene()
    const physics = await physicsFor()
    let impacts = 0
    const waterfall = new LakeWaterfall(
      scene,
      fall,
      false,
      false,
      () => {},
      physics,
      () => impacts++,
    )
    waterfall.update(0, 1, 1, steadyWind)
    waterfall.update(0.3, 1, 1, steadyWind)
    expect(impacts).toBe(0)
    physics.world.timestep = 1 / 60
    for (let frame = 1; frame <= 90; frame++) {
      waterfall.update(frame / 60, 1, 1, steadyWind)
      physics.world.step()
      waterfall.syncCurtain()
    }
    expect(impacts).toBeGreaterThan(0)
    const beforePause = impacts
    waterfall.update(60, 1, 1, steadyWind)
    waterfall.syncCurtain()
    waterfall.update(60, 1, 1, steadyWind)
    waterfall.syncCurtain()
    expect(impacts).toBe(beforePause)
    const releases: Array<Mock<() => void>> = []
    waterfall.group.traverse((object) => {
      if (!(object instanceof Mesh) || !(object.geometry instanceof BufferGeometry)) return
      const release = vi.fn<() => void>()
      object.geometry.addEventListener('dispose', release)
      releases.push(release)
    })
    for (const material of waterfall.materials) {
      const release = vi.fn<() => void>()
      material.addEventListener('dispose', release)
      releases.push(release)
    }
    const emitted = impacts
    waterfall.dispose()
    waterfall.dispose()
    waterfall.update(120, 1, 1, steadyWind)
    expect(impacts).toBe(emitted)
    expect(scene.children).toHaveLength(0)
    for (const release of releases) expect(release).toHaveBeenCalledTimes(1)
    physics.dispose()
  })

  it('keeps reduced-motion water visible without emitting spray', async () => {
    const scene = new Scene()
    const physics = await physicsFor()
    const waterfall = new LakeWaterfall(
      scene,
      fall,
      true,
      true,
      () => {
        throw new Error('Reduced motion must not emit spray')
      },
      physics,
      () => {
        throw new Error('Reduced motion must not emit impacts')
      },
    )
    waterfall.update(0, 0, 1, steadyWind)
    waterfall.update(60, 1, 1, steadyWind)
    expect(waterfall.group.visible).toBe(true)
    const basin = waterfall.group.getObjectByName('waterfall-basin')
    expect(basin).toBeInstanceOf(Mesh)
    if (!(basin instanceof Mesh) || !(basin.geometry instanceof BufferGeometry))
      throw new Error('Missing basin mesh')
    waterfall.group.updateMatrixWorld(true)
    const positions: unknown = basin.geometry.getAttribute('position')
    if (!(positions instanceof BufferAttribute)) throw new Error('Missing basin positions')
    let lipVertices = 0
    for (let i = 0; i < positions.count; i++) {
      const y = positions.getY(i) + waterfall.group.position.y
      expect(y).toBeLessThanOrEqual(fall.top + 1e-6)
      expect(y).toBeGreaterThanOrEqual(fall.top - 0.1)
      if (positions.getZ(i) > 0) lipVertices++
    }
    expect(lipVertices).toBeGreaterThan(0)
    const parcels = streamed(waterfall, 'aBodyPosition')
    let connected = 0
    for (let i = 0; i < parcels.length; i += 3) {
      const y = parcels[i + 1] ?? 0
      const z = parcels[i + 2] ?? 0
      if (y > fall.top - 0.16 - waterfall.group.position.y && z > 0.02 && z < 0.2) connected++
    }
    expect(connected).toBeGreaterThan(0)
    waterfall.dispose()
    physics.dispose()
  })

  it('lands foot jets through the shared pool and rings each return', async () => {
    const block: Voxel = { x: 0, y: 0.5, z: 0, size: 4, color: 0 }
    const bed = createLakeBed([block], 42, true)
    const physics = await physicsFor([block])
    const scene = new Scene()
    const splashes = new LakeSplashes(scene, bed, 42, true, physics)
    const waterfall = new LakeWaterfall(
      scene,
      fall,
      false,
      false,
      (jet) => splashes.emit(jet),
      physics,
      (impact, wind) => splashes.waterfallImpact(impact, wind),
    )
    const returns: number[][] = []
    splashes.onReturn = (...impact) => returns.push(impact)
    const calm = new WindModel(42, { meanSpeed: 0, gustStrength: 0, turnStrength: 0 })
    for (let frame = 0; frame < 240; frame++) {
      const time = frame / 60
      const wind = calm.sample(time)
      waterfall.update(time, 1, 1, wind)
      splashes.update(time, wind)
      waterfall.syncCurtain()
    }
    expect(splashes.impacts.landed).toBeGreaterThan(10)
    expect(returns).toHaveLength(splashes.impacts.landed)
    for (const [x, z, radius, velocity] of returns) {
      expect(x).toBeGreaterThan(fall.x)
      expect(Math.abs((z ?? 0) - fall.z)).toBeLessThan(fall.width)
      expect(radius).toBeGreaterThan(0)
      expect(velocity).toBeLessThan(0)
    }
    waterfall.dispose()
    splashes.dispose()
    physics.dispose()
    expect(scene.children).toHaveLength(0)
  })

  it('parts the curtain around the cursor blocker without penetrating its core', async () => {
    const scene = new Scene()
    const physics = await physicsFor()
    physics.world.timestep = 1 / 60
    const fragments: SplashJet[] = []
    const waterfall = new LakeWaterfall(
      scene,
      fall,
      false,
      false,
      (jet) => fragments.push(jet),
      physics,
      () => {},
    )
    waterfall.setBlock(0, 1.5, 0.45, 1)
    for (let frame = 0; frame < 240; frame++) {
      const time = frame / 60
      waterfall.update(time, 1, 1, steadyWind)
      physics.world.step()
      waterfall.syncCurtain()
    }
    const positions = streamed(waterfall, 'aBodyPosition')
    const foams = streamed(waterfall, 'aBodyFoam')
    let inBand = 0,
      foamed = 0,
      clearance = Infinity
    const depths: number[] = []
    for (let i = 0; i < foams.length; i++) {
      const base = i * 3
      const x = positions[base] ?? 0,
        y = positions[base + 1] ?? 0,
        z = positions[base + 2] ?? 0
      if (Math.abs(y - 1.5) > 0.16) continue
      inBand++
      depths.push(z)
      clearance = Math.min(clearance, Math.hypot(x, z - 0.69))
      if ((foams[i] ?? 0) > 0.5) foamed++
    }
    expect(inBand).toBeGreaterThan(20)
    depths.sort((a, b) => a - b)
    // The sheet really falls through the blocker's drift line; the void is in the water.
    expect(Math.abs((depths[Math.floor(depths.length / 2)] ?? 0) - 0.69)).toBeLessThan(0.25)
    expect(clearance).toBeGreaterThan((0.04 + 0.41 * 0.65 + 0.035) * 0.8)
    expect(foamed).toBeGreaterThan(0)
    expect(fragments.length).toBeGreaterThan(0)
    expect(fragments.every((jet) => jet.y > 1)).toBe(true)
    waterfall.setBlock(0, 1.5, 0.45, 0)
    for (let frame = 240; frame < 420; frame++) {
      const time = frame / 60
      waterfall.update(time, 1, 1, steadyWind)
      physics.world.step()
      waterfall.syncCurtain()
    }
    let restoredClearance = Infinity
    for (let i = 0; i < foams.length; i++) {
      const base = i * 3
      const x = positions[base] ?? 0,
        y = positions[base + 1] ?? 0,
        z = positions[base + 2] ?? 0
      if (Math.abs(y - 1.5) < 0.16)
        restoredClearance = Math.min(restoredClearance, Math.hypot(x, z - 0.69))
    }
    expect(restoredClearance).toBeLessThan(clearance * 0.65)
    waterfall.dispose()
    physics.dispose()
  })

  it('replays the same curtain deterministically from the seed', async () => {
    const run = async () => {
      const physics = await physicsFor()
      physics.world.timestep = 1 / 60
      const waterfall = new LakeWaterfall(
        scene,
        fall,
        false,
        false,
        () => {},
        physics,
        () => {},
      )
      waterfall.setBlock(0.2, 1.2, 0.45, 0.8)
      for (let frame = 0; frame < 120; frame++) {
        const time = frame / 60
        waterfall.update(time, 1, 1, steadyWind)
        physics.world.step()
        waterfall.syncCurtain()
      }
      const positions = Array.from(streamed(waterfall, 'aBodyPosition'))
      const velocities = Array.from(streamed(waterfall, 'aBodyVelocity'))
      waterfall.dispose()
      physics.dispose()
      return { positions, velocities }
    }
    const scene = new Scene()
    const first = await run()
    const second = await run()
    expect(second.positions).toEqual(first.positions)
    expect(second.velocities).toEqual(first.velocities)
    expect(scene.children).toHaveLength(0)
  })
})
