import { describe, expect, it } from 'vitest'

import { required } from '../invariant'
import { createPhysicsWorld, loadPhysics, mergeStaticBoxes } from './physics-world'
import { createVoxelIndex, firstVoxelHit } from './voxel-spatial'
import type { Voxel } from './voxel-world'

const voxel = (x: number, y: number, z: number, size = 1): Voxel => ({ x, y, z, size, color: 0 })

function mulberry(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

const inside = (merged: Float64Array, x: number, y: number, z: number) => {
  for (let i = 0; i + 5 < merged.length; i += 6) {
    if (
      x >= required(merged[i]) &&
      x <= required(merged[i + 3]) &&
      y >= required(merged[i + 1]) &&
      y <= required(merged[i + 4]) &&
      z >= required(merged[i + 2]) &&
      z <= required(merged[i + 5])
    )
      return true
  }
  return false
}

describe('physics statics', () => {
  it('merges adjacent voxel boxes without losing coverage', () => {
    const voxels: Voxel[] = []
    for (let x = 0; x < 12; x++)
      for (let z = 0; z < 8; z++) for (let y = 0; y < 2; y++) voxels.push(voxel(x, y, z))
    voxels.push(voxel(40, 5, -30, 0.25))
    const index = createVoxelIndex(voxels)
    const merged = mergeStaticBoxes(index.boxes)
    expect(merged.length / 6).toBe(2)
    for (const box of voxels) expect(inside(merged, box.x, box.y, box.z)).toBe(true)
  })

  it('matches the voxel raycast on seeded segments', async () => {
    const voxels: Voxel[] = []
    const random = mulberry(7)
    for (let i = 0; i < 60; i++)
      voxels.push(
        voxel(
          Math.floor(random() * 20) - 10,
          Math.floor(random() * 6),
          Math.floor(random() * 20) - 10,
        ),
      )
    const index = createVoxelIndex(voxels)
    const physics = createPhysicsWorld(await loadPhysics(), index)
    try {
      expect(physics.staticCount).toBeGreaterThan(0)
      const mismatches: number[] = []
      for (let i = 0; i < 200; i++) {
        const a = {
          x: random() * 30 - 15,
          y: random() * 12 - 2,
          z: random() * 30 - 15,
        }
        const b = { x: random() * 30 - 15, y: random() * 12 - 2, z: random() * 30 - 15 }
        const expected = firstVoxelHit(
          index,
          [a.x, a.y, a.z],
          [b.x - a.x, b.y - a.y, b.z - a.z],
          1,
          true,
        )
        const actual = physics.trace(a, b)
        const matches =
          expected === null ? actual === Infinity : Math.abs(actual - expected.distance) < 1e-6
        if (!matches) mismatches.push(i)
      }
      expect(mismatches).toEqual([])
    } finally {
      physics.dispose()
    }
  })

  it('intercepts a fast diagonal segment at the first voxel, including thin roofs', async () => {
    const index = createVoxelIndex([voxel(0, 2, 0, 0.1), voxel(0, 1, 0, 0.1)])
    const physics = createPhysicsWorld(await loadPhysics(), index)
    try {
      expect(physics.trace({ x: 0, y: 3, z: 0 }, { x: 0, y: -2, z: 0 })).toBeCloseTo(0.19, 6)
      expect(physics.trace({ x: -1, y: 3, z: 0 }, { x: 1, y: 1, z: 0 })).toBeCloseTo(0.475, 6)
      expect(physics.trace({ x: 0, y: 2, z: 0 }, { x: 2, y: 2, z: 0 })).toBe(0)
      expect(physics.trace({ x: 1, y: 3, z: 0 }, { x: 1, y: -2, z: 0 })).toBe(Infinity)
    } finally {
      physics.dispose()
    }
  })

  it('never discards cell-boundary, empty-column or long-segment hits', async () => {
    const voxels = Array.from({ length: 64 }, (_, i) => ({
      x: ((i % 8) - 4) * 2,
      y: i % 5,
      z: (Math.floor(i / 8) - 4) * 2,
      size: i % 3 === 0 ? 0.125 : 1,
      color: 0,
    }))
    const index = createVoxelIndex(voxels)
    const physics = createPhysicsWorld(await loadPhysics(), index)
    try {
      const mismatches: number[] = []
      for (let i = 0; i < 500; i++) {
        const a = { x: Math.sin(i * 7) * 12, y: (i % 8) - 1, z: Math.cos(i * 3) * 12 }
        const b = { x: Math.cos(i * 5) * 12, y: -2, z: Math.sin(i * 11) * 12 }
        const expected = firstVoxelHit(
          index,
          [a.x, a.y, a.z],
          [b.x - a.x, b.y - a.y, b.z - a.z],
          1,
          true,
        )
        const actual = physics.trace(a, b)
        const matches =
          expected === null ? actual === Infinity : Math.abs(actual - expected.distance) < 1e-6
        if (!matches) mismatches.push(i)
      }
      expect(mismatches).toEqual([])
      for (const box of voxels) {
        const top = { x: box.x, y: 20, z: box.z }
        const bottom = { x: box.x, y: -2, z: box.z }
        expect(physics.trace(top, bottom)).toBeLessThan(1)
        const edge = { x: box.x + box.size / 2, y: 20, z: box.z }
        const edgeBottom = { x: box.x + box.size / 2, y: -2, z: box.z }
        expect(physics.trace(edge, edgeBottom)).toBeLessThan(1)
      }
      const empty = createPhysicsWorld(await loadPhysics(), createVoxelIndex([]))
      try {
        expect(empty.trace({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 })).toBe(Infinity)
      } finally {
        empty.dispose()
      }
    } finally {
      physics.dispose()
    }
  })

  it('reports ray distances for picking, or null on a miss', async () => {
    const index = createVoxelIndex([voxel(0, 0, -10)])
    const physics = createPhysicsWorld(await loadPhysics(), index)
    try {
      expect(physics.castDistance({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 130)).toBeCloseTo(
        9.5,
      )
      expect(physics.castDistance({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 130)).toBe(null)
    } finally {
      physics.dispose()
    }
  })
})
