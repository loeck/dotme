import { BufferAttribute, BufferGeometry, DataUtils, PlaneGeometry } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { required } from '../invariant'
import { prepareGeometryBounds, prepareShadowBounds } from './geometry-bounds'
import { LAKE_BOUNDS, WATER_LEVEL } from './lake-bed'
import type { LakeBed } from './lake-bed'
import {
  prepareSubmergedSurface,
  prepareWaterMask,
  prepareWaterSurface,
} from './lake-geometry-data'
import { worldTransfers } from './world-data'

function sampleBed(): LakeBed {
  const resolution = 8
  return {
    resolution,
    water: new Uint8Array(resolution ** 2).fill(255),
    depth: Float32Array.from({ length: resolution ** 2 }, (_, i) => (i % 11) / 3),
    obstacle: new Float32Array(resolution ** 2),
    shore: Float32Array.from({ length: (resolution * 2) ** 2 }, (_, i) => (i % 13) / 4 - 1),
    stones: [],
  }
}

describe('worker-prepared lake surfaces', () => {
  it('preserves bed positions, winding, smooth normals and the native half-float atlas', () => {
    const bed = sampleBed()
    const prepared = prepareSubmergedSurface(bed)
    const n = bed.resolution
    const reference = new PlaneGeometry(LAKE_BOUNDS.size, LAKE_BOUNDS.size, n - 1, n - 1)
    const positions = reference.getAttribute('position')
    for (let i = 0; i < positions.count; i++)
      positions.setXYZ(
        i,
        LAKE_BOUNDS.minX + (((i % n) + 0.5) * LAKE_BOUNDS.size) / n,
        WATER_LEVEL - Math.max(0.04, required(bed.depth[i])),
        LAKE_BOUNDS.minZ + ((Math.floor(i / n) + 0.5) * LAKE_BOUNDS.size) / n,
      )
    reference.computeVertexNormals()
    expect(prepared.geometry.positions).toEqual(positions.array)
    expect(prepared.geometry.indices).toEqual(required(reference.index).array)
    const normals = reference.getAttribute('normal').array
    prepared.geometry.normals.forEach((normal, i) =>
      expect(normal).toBeCloseTo(required(normals[i]), 6),
    )
    expect(prepared.geometry.uv).toEqual(reference.getAttribute('uv').array)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++)
        expect(prepared.atlas[y * prepared.atlasWidth + x]).toBe(
          DataUtils.toHalfFloat(required(bed.depth[y * n + x])),
        )
    bed.shore.forEach((shore, i) =>
      expect(prepared.atlas[n * prepared.atlasWidth + i]).toBe(DataUtils.toHalfFloat(shore)),
    )
    reference.dispose()
  })

  it('preserves the nonlinear water grid and its culling sphere', () => {
    const prepared = prepareWaterSurface(true)
    const reference = new PlaneGeometry(1, 1, 192, 192)
    const positions = reference.getAttribute('position')
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i) * 2,
        t = 0.5 + positions.getY(i)
      positions.setXYZ(i, Math.sign(x) * Math.abs(x) ** 2.6 * 500, -(24 - t ** 2.6 * 524), 0)
    }
    reference.computeBoundingSphere()
    expect(prepared.positions).toEqual(positions.array)
    expect(prepared.normals).toEqual(reference.getAttribute('normal').array)
    expect(prepared.indices).toEqual(required(reference.index).array)
    expect(prepared.uv).toEqual(reference.getAttribute('uv').array)
    expect(prepared.boundingCenter).toEqual(required(reference.boundingSphere).center.toArray())
    expect(prepared.boundingRadius).toBe(required(reference.boundingSphere).radius)
    reference.dispose()
  })

  it('transfers every mesh, texture and mask buffer without copying ownership', () => {
    const bed = sampleBed()
    const payload = {
      submerged: prepareSubmergedSurface(bed),
      water: prepareWaterSurface(true),
      mask: prepareWaterMask(bed),
    }
    expect(payload.mask.resolution).toBe(16)
    expect(payload.mask.water).toEqual(
      Uint8Array.from(bed.shore, (distance) => (distance > 0 ? 255 : 0)),
    )
    const transfers = worldTransfers(payload)
    expect(transfers).toHaveLength(11)
    const delivered = structuredClone(payload, { transfer: transfers })
    expect(payload.submerged.geometry.positions.byteLength).toBe(0)
    expect(payload.water.positions.byteLength).toBe(0)
    expect(payload.mask.water.byteLength).toBe(0)
    expect(delivered.submerged.geometry.positions.length).toBe(bed.resolution ** 2 * 3)
    expect(delivered.mask.water.length).toBe(bed.shore.length)
  })
})

describe('worker-prepared bounds', () => {
  it('matches BufferGeometry bounds and contains transformed shadow cubes', () => {
    const positions = new Float32Array([-7, 3, 0, 2, 9, -4, 5, -2, 8])
    const bounds = prepareGeometryBounds(positions)
    const reference = new BufferGeometry().setAttribute(
      'position',
      new BufferAttribute(positions, 3),
    )
    reference.computeBoundingBox()
    reference.computeBoundingSphere()
    expect(bounds.min).toEqual(required(reference.boundingBox).min.toArray())
    expect(bounds.max).toEqual(required(reference.boundingBox).max.toArray())
    expect(bounds.center).toEqual(required(reference.boundingSphere).center.toArray())
    expect(bounds.radius).toBe(required(reference.boundingSphere).radius)
    const matrices = new Float32Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 3, -1, 7, 1])
    const shadow = prepareShadowBounds(matrices)
    expect(shadow.min).toEqual([2, -2, 6])
    expect(shadow.max).toEqual([4, 0, 8])
    expect(shadow.radius).toBe(Math.sqrt(3))
    reference.dispose()
  })
})
