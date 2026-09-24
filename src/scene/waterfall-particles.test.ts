import { uniform } from 'three/tsl'
import { InstancedBufferAttribute } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { WATER_LEVEL } from './lake-bed'
import type { VoxelWaterfall } from './voxel-world'
import { createWaterfallParticles } from './waterfall-particles'

const fall = {
  x: -16,
  z: -15,
  top: 2,
  width: 1.8,
  seed: 9182,
  direction: [1, 0],
  basin: [],
} satisfies VoxelWaterfall

describe('waterfall parcel volume', () => {
  it('keeps the complete source volume underwater and distributes emission through time', () => {
    const field = createWaterfallParticles(fall, false, uniform(0))
    const origins = field.geometry.getAttribute('aWaterfallOrigin')
    const dynamics = field.geometry.getAttribute('aWaterfallDynamics')
    if (
      !(origins instanceof InstancedBufferAttribute) ||
      !(dynamics instanceof InstancedBufferAttribute)
    )
      throw new Error('Missing waterfall emission data')
    const height = fall.top - WATER_LEVEL
    let minPhase = 1,
      maxPhase = 0,
      minDepth = Infinity,
      maxDepth = -Infinity
    let sourceInside = true
    for (let i = 0; i < origins.count; i++) {
      const radius = origins.getW(i)
      sourceInside &&=
        origins.getY(i) + radius <= height + 1e-6 &&
        origins.getY(i) - radius >= height - 0.2 - 1e-6 &&
        Math.abs(origins.getX(i)) + radius <= fall.width / 2 + 1e-6 &&
        dynamics.getW(i) > 0
      minPhase = Math.min(minPhase, dynamics.getX(i))
      maxPhase = Math.max(maxPhase, dynamics.getX(i))
      minDepth = Math.min(minDepth, origins.getZ(i))
      maxDepth = Math.max(maxDepth, origins.getZ(i))
    }
    expect(sourceInside).toBe(true)
    expect(minPhase).toBeLessThan(0.01)
    expect(maxPhase).toBeGreaterThan(0.99)
    expect(maxDepth - minDepth).toBeGreaterThan(0.045)
    expect(field.geometry.instanceCount).toBe(origins.count)
    expect(field.bounds.min.y).toBeLessThan(-0.2)
    expect(field.bounds.max.y).toBeGreaterThan(height)
    expect(field.geometry.boundingSphere?.radius).toBeGreaterThan(height / 2)
    field.geometry.dispose()
  })

  it('uses deterministic independent parcels and reduces geometry on mobile', () => {
    const desktop = createWaterfallParticles(fall, false, uniform(0))
    const repeated = createWaterfallParticles(fall, false, uniform(12))
    const different = createWaterfallParticles({ ...fall, seed: 1 }, false, uniform(0))
    const mobile = createWaterfallParticles(fall, true, uniform(0))
    const desktopOrigins = desktop.geometry.getAttribute('aWaterfallOrigin')
    expect(desktopOrigins.array).toEqual(repeated.geometry.getAttribute('aWaterfallOrigin').array)
    expect(desktopOrigins.array).not.toEqual(
      different.geometry.getAttribute('aWaterfallOrigin').array,
    )
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
