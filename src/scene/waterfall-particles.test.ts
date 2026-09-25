import { InstancedBufferAttribute } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { WATER_LEVEL } from './lake-bed'
import type { VoxelWaterfall } from './voxel-world'
import { createWaterfallParticles, curtainParcelCount } from './waterfall-particles'

const fall = {
  x: -16,
  z: -15,
  top: 2,
  width: 1.8,
  seed: 9182,
  direction: [1, 0],
  basin: [],
} satisfies VoxelWaterfall

const attribute = (field: ReturnType<typeof createWaterfallParticles>, name: string) => {
  const found = field.geometry.getAttribute(name)
  if (!(found instanceof InstancedBufferAttribute)) throw new Error(`Missing ${name}`)
  return found
}

describe('waterfall parcel volume', () => {
  it('sizes slots deterministically and streams body state every frame', () => {
    const field = createWaterfallParticles(fall, false)
    const height = fall.top - WATER_LEVEL
    expect(field.count).toBe(curtainParcelCount(false))
    expect(field.geometry.instanceCount).toBe(field.count)
    expect(field.sizes).toHaveLength(field.count)
    const sizes = attribute(field, 'aBodySize')
    expect(sizes.count).toBe(field.count)
    expect(Array.from(sizes.array)).toEqual(Array.from(field.sizes))
    let min = Infinity,
      max = -Infinity
    for (const size of field.sizes) {
      min = Math.min(min, size)
      max = Math.max(max, size)
    }
    expect(min).toBeGreaterThanOrEqual(0.035)
    expect(max).toBeLessThanOrEqual(0.06)
    expect(max - min).toBeGreaterThan(0.015)
    for (const name of ['aBodyPosition', 'aBodyVelocity', 'aBodyFoam']) {
      const stream = attribute(field, name)
      expect(stream.count).toBe(field.count)
      expect(stream.array.every((value) => value === 0)).toBe(true)
    }
    expect(field.bounds.min.y).toBeLessThan(-0.2)
    expect(field.bounds.max.y).toBeGreaterThan(height)
    expect(field.geometry.boundingSphere?.radius).toBeGreaterThan(height / 2)
    field.geometry.dispose()
  })

  it('uses deterministic independent parcels and reduces geometry on mobile', () => {
    const desktop = createWaterfallParticles(fall, false)
    const repeated = createWaterfallParticles(fall, false)
    const different = createWaterfallParticles({ ...fall, seed: 1 }, false)
    const mobile = createWaterfallParticles(fall, true)
    expect(Array.from(repeated.sizes)).toEqual(Array.from(desktop.sizes))
    expect(Array.from(different.sizes)).not.toEqual(Array.from(desktop.sizes))
    expect(mobile.count).toBe(curtainParcelCount(true))
    const desktopIndex = desktop.geometry.getIndex()
    const mobileIndex = mobile.geometry.getIndex()
    if (!desktopIndex || !mobileIndex) throw new Error('Missing parcel sphere topology')
    expect(mobile.geometry.instanceCount).toBeGreaterThan(0)
    expect(mobile.geometry.instanceCount).toBeLessThanOrEqual(desktop.geometry.instanceCount / 2)
    expect((desktopIndex.count / 3) * desktop.geometry.instanceCount).toBeLessThanOrEqual(200_000)
    expect((mobileIndex.count / 3) * mobile.geometry.instanceCount).toBeLessThanOrEqual(50_000)
    expect(mobile.geometry.getAttribute('position').count).toBeLessThan(
      desktop.geometry.getAttribute('position').count,
    )
    for (const field of [desktop, repeated, different, mobile]) field.geometry.dispose()
  })
})
