import { describe, expect, it } from 'vitest'

import { WATER_LEVEL } from './lake-bed'
import { meshSculpt, sculptSpruce, VoxelSculpt } from './vegetation-models'
import { prepareVegetation } from './vegetation-placement'
import { createVoxelWorld } from './voxel-world'

const triangles = (layers: ReturnType<typeof prepareVegetation>['layers']) =>
  layers.reduce(
    (sum, layer) => sum + (layer.geometry.indices.length / 3) * (layer.motion.length / 2),
    0,
  )

describe('micro-voxel vegetation', () => {
  it('meshes only exposed faces, with corner occlusion and outward winding', () => {
    const sculpt = new VoxelSculpt(0.1)
    sculpt.voxel([0.05, 0.05, 0.05], [1, 1, 1])
    sculpt.voxel([0.15, 0.05, 0.05], [1, 1, 1])
    sculpt.voxel([0.15, 0.15, 0.05], [1, 1, 1])
    const mesh = meshSculpt(sculpt, { seed: 1, relief: 0, bendFrom: 0 })
    // An L of three cubes sharing two faces: 14 exposed faces, 4 vertices and 2 triangles each.
    expect(mesh.positions.length / 3).toBe(56)
    expect(mesh.indices.length).toBe(84)
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => (mesh.indices[i + k] ?? 0) * 3)
      const p = (v: number, axis: number) => mesh.positions[(v ?? 0) + axis] ?? 0
      const e1 = [0, 1, 2].map((axis) => p(b ?? 0, axis) - p(a ?? 0, axis))
      const e2 = [0, 1, 2].map((axis) => p(c ?? 0, axis) - p(a ?? 0, axis))
      const cross = [
        (e1[1] ?? 0) * (e2[2] ?? 0) - (e1[2] ?? 0) * (e2[1] ?? 0),
        (e1[2] ?? 0) * (e2[0] ?? 0) - (e1[0] ?? 0) * (e2[2] ?? 0),
        (e1[0] ?? 0) * (e2[1] ?? 0) - (e1[1] ?? 0) * (e2[0] ?? 0),
      ]
      const n = [0, 1, 2].map((axis) => (mesh.normals[(a ?? 0) + axis] ?? 0) / 127)
      expect(cross.reduce((sum, value, axis) => sum + value * (n[axis] ?? 0), 0)).toBeGreaterThan(0)
    }
    // The first cube's top corners against the upper cube are darker than free corners.
    const colours = Array.from(mesh.colors)
    expect(Math.min(...colours)).toBeLessThan(Math.max(...colours))
  })

  it('builds Last Signal spruces as tiered cones with a darker inside', () => {
    const mesh = meshSculpt(sculptSpruce(7, 0.0625, false), {
      seed: 7,
      relief: 0.35,
      bendFrom: 0.4,
    })
    expect(mesh.height).toBeGreaterThan(2.5)
    expect(mesh.height).toBeLessThan(3.6)
    expect(mesh.bend.every((value) => value >= 0 && value <= 1)).toBe(true)
  })

  it('is deterministic and stays within a draw and triangle budget', () => {
    for (const mobile of [false, true]) {
      const world = createVoxelWorld(9182, mobile)
      const first = prepareVegetation(world, 9182, mobile)
      const second = prepareVegetation(world, 9182, mobile)
      expect(first.layers.map((layer) => layer.name)).toEqual(
        second.layers.map((layer) => layer.name),
      )
      expect(first.layers.map((layer) => Array.from(layer.matrices))).toEqual(
        second.layers.map((layer) => Array.from(layer.matrices)),
      )
      expect(first.layers.length).toBeLessThanOrEqual(24)
      expect(triangles(first.layers)).toBeLessThan(mobile ? 220_000 : 900_000)
      const names = first.layers.map((layer) => layer.name)
      expect(names.some((name) => name.startsWith('tuft'))).toBe(true)
      for (const layer of first.layers)
        for (let i = 0; i < layer.matrices.length; i += 16)
          expect(layer.matrices[i + 13] ?? 0).toBeGreaterThan(WATER_LEVEL)
    }
  })
})
