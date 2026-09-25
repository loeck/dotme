import { InstancedMesh, Matrix4, Scene, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { createLakeBed } from './lake-bed'
import { LakeWaterMaterial } from './lake-water'
import { createPhysicsWorld, loadPhysics } from './physics-world'
import { SceneDetails, updateDetailEnvironment } from './scene-details'
import { createVoxelIndex } from './voxel-spatial'
import type { Voxel } from './voxel-world'
import { WindModel } from './wind'

describe('detail environment bridge', () => {
  it('preserves independent solar/rain inputs when either source updates', () => {
    const state = updateDetailEnvironment({ rainIntensity: 0.6, daylight: 0.2 }, { daylight: 0.8 })
    expect(state).toEqual({ rainIntensity: 0.6, daylight: 0.8 })
    expect(updateDetailEnvironment(state, { rainIntensity: 0 })).toEqual({
      rainIntensity: 0,
      daylight: 0.8,
    })
  })

  it('bounds external values and ignores non-finite data', () => {
    const current = { rainIntensity: 0.4, daylight: 0.7 }
    expect(updateDetailEnvironment(current, { rainIntensity: NaN, daylight: Infinity })).toEqual(
      current,
    )
    expect(updateDetailEnvironment(current, { rainIntensity: 3, daylight: -1 })).toEqual({
      rainIntensity: 1,
      daylight: 0,
    })
  })
})

const block: Voxel = { x: 0, y: 0.5, z: 0, size: 4, color: 0 }
const bed = createLakeBed([block], 42, true)
const windy = new WindModel(42, { meanSpeed: 8, bearing: 0, gustStrength: 0, turnStrength: 0 })

const firstInstance = (scene: Scene, name: string) => {
  const mesh = scene.children.find((child) => child.name === name)
  if (!(mesh instanceof InstancedMesh)) throw new Error(`Missing instanced mesh ${name}`)
  const matrix = new Matrix4()
  mesh.getMatrixAt(0, matrix)
  return new Vector3().setFromMatrixPosition(matrix).toArray()
}

describe('details water layer', () => {
  it('routes pointer bursts to splash impulses and advances floaters and foam', async () => {
    const physics = createPhysicsWorld(await loadPhysics(), createVoxelIndex([block]))
    const scene = new Scene()
    const material = new LakeWaterMaterial()
    const details = new SceneDetails(
      scene,
      { seed: 42, lakeBed: bed, waterfall: null },
      true,
      false,
      physics,
    )
    try {
      const returns: number[][] = []
      details.setWaterImpact(
        (x, z, radius, velocity) => returns.push([x, z, radius, velocity]),
        material.uniforms,
      )
      const floaterStart = firstInstance(scene, 'floating-bodies')
      const foamStart = firstInstance(scene, 'drifting-foam')
      details.pointerBurst(5, -5, 0.55, 0, windy.sample(0))
      for (let frame = 0; frame < 120; frame++) {
        const time = frame / 60
        details.update(time, 1 / 60, windy.sample(time), null, null, 0, 1)
      }
      expect(returns.length).toBeGreaterThan(0)
      expect(firstInstance(scene, 'floating-bodies')).not.toEqual(floaterStart)
      expect(firstInstance(scene, 'drifting-foam')).not.toEqual(foamStart)
    } finally {
      details.dispose()
      material.dispose()
      physics.dispose()
    }
  })

  it('holds pointer bursts still under reduced motion', async () => {
    const physics = createPhysicsWorld(await loadPhysics(), createVoxelIndex([block]))
    const scene = new Scene()
    const details = new SceneDetails(
      scene,
      { seed: 42, lakeBed: bed, waterfall: null },
      true,
      true,
      physics,
    )
    try {
      const returns: number[][] = []
      details.setWaterImpact(
        (x, z, radius, velocity) => returns.push([x, z, radius, velocity]),
        new LakeWaterMaterial().uniforms,
      )
      const foamStart = firstInstance(scene, 'drifting-foam')
      details.pointerBurst(5, -5, 0.55, 0, windy.sample(0))
      for (let frame = 0; frame < 60; frame++) {
        const time = frame / 60
        details.update(time, 1 / 60, windy.sample(time), null, null, 0, 1)
      }
      expect(returns).toHaveLength(0)
      expect(firstInstance(scene, 'drifting-foam')).toEqual(foamStart)
    } finally {
      details.dispose()
      physics.dispose()
    }
  })
})
