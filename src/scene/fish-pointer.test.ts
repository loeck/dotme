import { PerspectiveCamera, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { apparentFishSurface, sampleFishPointer } from './fish-pointer'
import { WATER_LEVEL } from './lake-bed'

describe('visible underwater fish interaction', () => {
  it('selects the apparent fish at different depths and distances with the same screen radius', () => {
    const camera = new PerspectiveCamera(54, 1440 / 900, 0.05, 500)
    camera.position.set(0, 2.3, 16)
    camera.lookAt(0, 0, -25)
    camera.updateMatrixWorld()
    const target = { x: 0, z: 0, strength: 0 }
    for (const pose of [
      { x: -3, y: -1.5, z: 2 },
      { x: 2, y: -3, z: -25 },
    ]) {
      const screen = apparentFishSurface(pose, camera.position, new Vector3()).project(camera)
      const pointer = { ndc: { x: screen.x, y: screen.y }, camera, width: 1440, height: 900 }
      expect(sampleFishPointer(pose, pointer, target)).toBe(target)
      expect(target.strength).toBeCloseTo(1)
      expect(target.x).toBeCloseTo(pose.x)
      expect(target.z).toBeCloseTo(pose.z)
      pointer.ndc.x += 40 / 720
      sampleFishPointer(pose, pointer, target)
      expect(target.strength).toBeCloseTo(0.544066761)
      expect(Math.hypot(target.x - pose.x, target.z - pose.z)).toBeLessThanOrEqual(0.700001)
      pointer.ndc.x += 60 / 720
      expect(sampleFishPointer(pose, pointer, target)).toBeNull()
    }
  })

  it('returns no threat for pointer exit, sky and fish behind the camera', () => {
    const camera = new PerspectiveCamera(54, 1, 0.05, 100)
    camera.position.set(0, 2.3, 16)
    camera.lookAt(0, 2.3, -25)
    camera.updateMatrixWorld()
    const target = { x: 0, z: 0, strength: 1 }
    const pose = { x: 0, y: -1, z: 0 }
    expect(sampleFishPointer(pose, null, target)).toBeNull()
    expect(target.strength).toBe(0)
    const pointer = { ndc: { x: 0, y: 0.8 }, camera, width: 900, height: 900 }
    expect(sampleFishPointer(pose, pointer, target)).toBeNull()
    expect(sampleFishPointer({ ...pose, z: 40 }, pointer, target)).toBeNull()
  })

  it('keeps apparent points on water and within the refracted ray cone', () => {
    const camera = { x: 0, y: 2.3, z: 16 }
    const pose = { x: 3, y: -3, z: -20 }
    const surface = apparentFishSurface(pose, camera, new Vector3())
    expect(surface.y).toBe(WATER_LEVEL)
    const offset = Math.hypot(surface.x - pose.x, surface.z - pose.z)
    expect(offset).toBeGreaterThan(0)
    expect(offset).toBeLessThan((WATER_LEVEL - pose.y) * 1.136)
  })
})
