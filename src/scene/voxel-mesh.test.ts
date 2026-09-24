import { BoxGeometry, InstancedMesh, MeshBasicMaterial, Object3D, Raycaster, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { required } from '../invariant'
import { exposedVoxelFaces, prepareTerrain } from './voxel-mesh'
import { createVoxelIndex, firstVoxelHit } from './voxel-spatial'
import { createVoxelWorld } from './voxel-world'
import { worldTransfers } from './world-data'

const cube = (x = 0, y = 0, z = 0, size = 1) => ({ x, y, z, size, color: 0x123456 })

const solidKey = (x: number, y: number, z: number, size: number) =>
  [x, y, z, size].map(Math.fround).join(':')

describe('static terrain', () => {
  it('removes only fully covered faces, including unions of smaller neighbors', () => {
    expect(exposedVoxelFaces(createVoxelIndex([cube()]), 0)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ])
    expect(exposedVoxelFaces(createVoxelIndex([cube(), cube(1)]), 0)).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
    ])
    const neighbors = [-0.25, 0.25].flatMap((y) => [-0.25, 0.25].map((z) => cube(0.75, y, z, 0.5)))
    expect(exposedVoxelFaces(createVoxelIndex([cube(), ...neighbors]), 0)[0]).toBe(false)
    expect(exposedVoxelFaces(createVoxelIndex([cube(), ...neighbors.slice(1)]), 0)[0]).toBe(true)
    expect(exposedVoxelFaces(createVoxelIndex([cube(), cube(1.001)]), 0)[0]).toBe(true)
    expect(exposedVoxelFaces(createVoxelIndex([cube(), cube(1, 0.01)]), 0)[0]).toBe(true)
    expect(exposedVoxelFaces(createVoxelIndex([cube(), cube(0, 0, 0, 3)]), 0).some(Boolean)).toBe(
      false,
    )
  })

  it('picks the same first front face as instanced cubes, including parallel and inside rays', () => {
    const voxels = Array.from({ length: 100 }, (_, i) =>
      cube(Math.sin(i * 3) * 8, Math.cos(i * 4) * 5, -i * 0.3, 0.4 + (i % 5) * 0.2),
    )
    const index = createVoxelIndex(voxels)
    const geometry = new BoxGeometry(),
      material = new MeshBasicMaterial()
    const mesh = new InstancedMesh(geometry, material, voxels.length),
      transform = new Object3D()
    voxels.forEach((v, i) => {
      transform.position.set(v.x, v.y, v.z)
      transform.scale.setScalar(v.size)
      transform.updateMatrix()
      mesh.setMatrixAt(i, transform.matrix)
    })
    const ray = new Raycaster()
    ray.far = 130
    for (let i = 0; i < 300; i++) {
      const v = required(voxels[i % voxels.length])
      const origin = i % 3 === 0 ? new Vector3(v.x, v.y, v.z) : new Vector3(Math.sin(i) * 10, 4, 10)
      const direction =
        i % 5 === 0 ? new Vector3(0, 0, -1) : new Vector3(v.x, v.y, v.z).sub(origin).normalize()
      if (!direction.lengthSq()) direction.set(0, -1, 0)
      ray.set(origin, direction)
      const reference = ray.intersectObject(mesh)[0]
      const actual = firstVoxelHit(index, origin.toArray(), direction.toArray())
      expect(!!actual).toBe(!!reference)
      expect(actual?.distance ?? -1).toBeCloseTo(reference?.distance ?? -1, 5)
    }
    mesh.dispose()
    geometry.dispose()
    material.dispose()
  })

  it.each([0, 12, 9182])(
    'preserves outward winding, batches and transferable data for seed %i',
    (seed) => {
      const world = createVoxelWorld(seed, false)
      const terrain = prepareTerrain(world)
      expect(terrain.exposedFaces).toBeLessThan(terrain.totalFaces * 0.65)
      const a = new Vector3(),
        b = new Vector3(),
        c = new Vector3(),
        normal = new Vector3()
      for (const batch of terrain.batches) {
        expect(batch.positions.length).toBe(batch.normals.length)
        expect(batch.colors.length).toBe(batch.positions.length)
        for (let i = 0; i < batch.indices.length; i += 6) {
          a.fromArray(batch.positions, required(batch.indices[i]) * 3)
          b.fromArray(batch.positions, required(batch.indices[i + 1]) * 3)
          c.fromArray(batch.positions, required(batch.indices[i + 2]) * 3)
          normal.fromArray(batch.normals, required(batch.indices[i]) * 3)
          expect(b.sub(a).cross(c.sub(a)).dot(normal)).toBeGreaterThan(0)
        }
      }
      const shadowSolids = new Map<string, number>()
      for (const voxel of world.voxels) {
        const id = solidKey(voxel.x, voxel.y, voxel.z, voxel.size)
        shadowSolids.set(id, (shadowSolids.get(id) ?? 0) + 1)
      }
      for (const matrices of terrain.shadowMatrices)
        for (let i = 0; i < matrices.length; i += 16) {
          const id = solidKey(
            required(matrices[i + 12]),
            required(matrices[i + 13]),
            required(matrices[i + 14]),
            required(matrices[i]),
          )
          const remaining = (shadowSolids.get(id) ?? 0) - 1
          if (remaining === 0) shadowSolids.delete(id)
          else shadowSolids.set(id, remaining)
        }
      expect(shadowSolids.size).toBe(0)
      const transfers = worldTransfers(terrain)
      expect(new Set(transfers).size).toBe(transfers.length)
      const copy = structuredClone(terrain, { transfer: transfers })
      expect(terrain.index.boxes.byteLength).toBe(0)
      expect(copy.index.boxes.length).toBe(world.voxels.length * 6)
    },
    30_000,
  )
})
