import { Color, PerspectiveCamera, Scene, Vector3 } from 'three'
import { describe, expect, it, vi } from 'vitest'

import { LAKE_BOUNDS, WATER_LEVEL, lakeIndex } from './lake-bed'
import type { LakeBed } from './lake-bed'
import { LakeFireflies } from './lake-fireflies'
import type { FireflyPointer } from './lake-fireflies'
import { LakeMist } from './lake-mist'
import { WindModel } from './wind'

function lakeBed(shores = true): LakeBed {
  const resolution = 64
  const water = new Uint8Array(resolution ** 2).fill(255)
  const depth = new Float32Array(water.length).fill(7)
  const obstacle = new Float32Array(water.length).fill(-100)
  for (let i = 0; i < water.length; i++) {
    const x = LAKE_BOUNDS.minX + (((i % resolution) + 0.5) * LAKE_BOUNDS.size) / resolution
    const z =
      LAKE_BOUNDS.minZ + ((Math.floor(i / resolution) + 0.5) * LAKE_BOUNDS.size) / resolution
    if (shores && Math.abs(x) > 12 && Math.abs(x) < 22 && z < 5 && z > -60) depth[i] = 1
    if (Math.abs(x) >= 22) {
      water[i] = 0
      obstacle[i] = 2
    }
  }
  return {
    resolution,
    water,
    depth,
    obstacle,
    shore: new Float32Array(water.length * 4),
    stones: [],
  }
}

function firstFly(flies: LakeFireflies) {
  return new Vector3().fromBufferAttribute(flies.mesh.geometry.getAttribute('aCenter'), 0)
}

function hoverCamera(flies: LakeFireflies, distance = 20) {
  const center = firstFly(flies)
  const camera = new PerspectiveCamera(54, 1000 / 700, 0.05, 500)
  camera.position.copy(center).add(new Vector3(0, 0, distance))
  camera.lookAt(center)
  camera.updateMatrixWorld()
  return camera
}

function hoverAt(
  flies: LakeFireflies,
  camera: PerspectiveCamera,
  offsetPixels: number,
): FireflyPointer {
  const projected = firstFly(flies).project(camera)
  return {
    ndc: { x: projected.x + (offsetPixels * 2) / 1000, y: projected.y },
    camera,
    width: 1000,
    height: 700,
  }
}

describe('lake atmosphere', () => {
  it('places deterministic mist on actual shallow water within a mobile instance budget', () => {
    const bed = lakeBed()
    const scene = new Scene()
    const first = new LakeMist(scene, bed, 91, false)
    const repeated = new LakeMist(scene, bed, 91, false)
    const mobile = new LakeMist(scene, bed, 91, true)
    const centers = first.mesh.geometry.getAttribute('aCenter')
    const shapes = first.mesh.geometry.getAttribute('aShape')
    expect(centers.array).toEqual(repeated.mesh.geometry.getAttribute('aCenter').array)
    expect(first.mesh.geometry.instanceCount).toBeGreaterThan(0)
    expect(first.mesh.geometry.instanceCount).toBeLessThanOrEqual(18)
    expect(mobile.mesh.geometry.instanceCount).toBeLessThanOrEqual(8)
    expect(mobile.mesh.geometry.instanceCount).toBeLessThan(first.mesh.geometry.instanceCount)
    for (let i = 0; i < centers.count; i++) {
      const index = lakeIndex(bed, centers.getX(i), centers.getZ(i))
      expect(bed.water[index]).toBe(255)
      expect(bed.depth[index]).toBeLessThan(3.2)
      // The water can clip the foot instead of leaving a levitating gap.
      expect(centers.getY(i) - shapes.getY(i) / 2).toBeLessThan(WATER_LEVEL)
      expect(centers.getY(i) + shapes.getY(i) / 2).toBeLessThan(WATER_LEVEL + 0.4)
    }
    for (const effect of [first, repeated, mobile]) effect.dispose()
  })

  it('does not invent colonies or wisps without eligible lake shores', () => {
    const scene = new Scene()
    const wind = new WindModel(0).sample(0)
    const mist = new LakeMist(scene, lakeBed(false), 0, false)
    const flies = new LakeFireflies(scene, lakeBed(false), 0, false)
    for (const effect of [mist, flies]) {
      effect.update(0, wind)
      expect(effect.mesh.geometry.instanceCount).toBe(0)
      expect(effect.mesh.visible).toBe(false)
      effect.dispose()
    }
  })

  it('keeps fireflies seeded and grouped while hiding them in daylight', () => {
    const scene = new Scene()
    const bed = lakeBed()
    const flies = new LakeFireflies(scene, bed, 91, false)
    const repeated = new LakeFireflies(scene, bed, 91, false)
    const mobile = new LakeFireflies(scene, bed, 91, true)
    expect(flies.mesh.geometry.getAttribute('aCenter').array).toEqual(
      repeated.mesh.geometry.getAttribute('aCenter').array,
    )
    expect(flies.mesh.geometry.instanceCount).toBeGreaterThan(0)
    expect(flies.mesh.geometry.instanceCount).toBeLessThanOrEqual(48)
    expect(flies.mesh.geometry.instanceCount % 6).toBe(0)
    expect(mobile.mesh.geometry.instanceCount).toBeLessThanOrEqual(18)
    const wind = new WindModel(0).sample(5)
    flies.update(5, wind, { nightFactor: 0 })
    expect(flies.mesh.visible).toBe(false)
    flies.update(5 + 1 / 60, wind, { nightFactor: 0.5 })
    expect(flies.mesh.visible).toBe(true)
    expect(flies.mesh.material.uniforms.uIntensity!.value).toBe(0.5)
    for (const effect of [flies, repeated, mobile]) effect.dispose()
  })

  it('eases screen-space entry, reversals, exact-center hover and exit across frame rates', () => {
    const bed = lakeBed()
    const wind = new WindModel(0)
    const responses: Vector3[][] = []
    for (const hz of [30, 60, 144]) {
      const flies = new LakeFireflies(new Scene(), bed, 0, false)
      const baseline = new LakeFireflies(new Scene(), bed, 0, false)
      flies.update(0, wind.sample(0))
      baseline.update(0, wind.sample(0))
      const camera = hoverCamera(baseline)
      let previousOffset = new Vector3()
      const samples: Vector3[] = []
      for (let i = 1; i <= hz * 4; i++) {
        const time = i / hz
        baseline.update(time, wind.sample(time))
        const offsetPixels = time <= 0.5 ? -35 : time <= 1 ? 35 : 0
        const pointer = time <= 2 ? hoverAt(baseline, camera, offsetPixels) : null
        flies.update(time, wind.sample(time), { pointer })
        const offset = firstFly(flies).sub(firstFly(baseline))
        expect(offset.length()).toBeLessThan(0.6)
        expect(offset.distanceTo(previousOffset)).toBeLessThan(0.06)
        if (i % (hz / 2) === 0) samples.push(offset.clone())
        previousOffset = offset
      }
      expect(samples[0]!.x).toBeGreaterThan(0.1)
      expect(samples[1]!.x).toBeLessThan(-0.1)
      expect(samples[3]!.length()).toBeGreaterThan(0.02)
      expect(samples[3]!.length()).toBeLessThan(0.05)
      expect(previousOffset.length()).toBeLessThan(0.00001)
      const sameFrame = firstFly(flies)
      flies.update(4, wind.sample(4), { pointer: hoverAt(baseline, camera, -35) })
      expect(firstFly(flies)).toEqual(sameFrame)
      responses.push(samples)
      baseline.dispose()
      flies.dispose()
    }
    for (const response of responses.slice(1)) {
      response.forEach((sample, i) =>
        expect(sample.distanceTo(responses[0]![i]!)).toBeLessThan(0.004),
      )
    }
  })

  it('uses a CSS-pixel hover radius at any scene depth without a terrain hit', () => {
    const bed = lakeBed()
    const wind = new WindModel(0)
    for (const distance of [20, 70]) {
      const flies = new LakeFireflies(new Scene(), bed, 0, false)
      const baseline = new LakeFireflies(new Scene(), bed, 0, false)
      flies.update(0, wind.sample(0))
      baseline.update(0, wind.sample(0))
      const camera = hoverCamera(baseline, distance)
      for (let i = 1; i <= 60; i++) {
        const time = i / 60
        baseline.update(time, wind.sample(time))
        flies.update(time, wind.sample(time), { pointer: hoverAt(baseline, camera, 100) })
      }
      expect(firstFly(flies)).toEqual(firstFly(baseline))
      // Ray/terrain discontinuities cannot affect interaction: no height or
      // terrain sample participates after the seeded colonies have been placed.
      bed.obstacle.fill(100)
      for (let i = 61; i <= 120; i++) {
        const time = i / 60
        baseline.update(time, wind.sample(time))
        flies.update(time, wind.sample(time), { pointer: hoverAt(baseline, camera, 40) })
      }
      const offset = firstFly(flies).sub(firstFly(baseline))
      expect(offset.x).toBeLessThan(-0.05)
      expect(offset.length()).toBeLessThan(0.6)
      bed.obstacle.fill(-100)
      baseline.dispose()
      flies.dispose()
    }
  })

  it('freezes motion and repulsion for reduced motion but still updates lighting', () => {
    const scene = new Scene()
    const wind = new WindModel(0)
    const mist = new LakeMist(scene, lakeBed(), 0, false)
    const flies = new LakeFireflies(scene, lakeBed(), 0, false)
    mist.update(20, wind.sample(20), { reducedMotion: true, daylight: 0 })
    const nightColor = (mist.mesh.material.uniforms.uColor!.value as Color).clone()
    mist.update(40, wind.sample(40), { reducedMotion: true, daylight: 1 })
    expect(mist.mesh.material.uniforms.uColor!.value).not.toEqual(nightColor)
    flies.update(20, wind.sample(20), { reducedMotion: true })
    const frozen = firstFly(flies)
    flies.update(40, wind.sample(40), {
      reducedMotion: true,
      pointer: hoverAt(flies, hoverCamera(flies), 0),
      nightFactor: 0.4,
    })
    for (const effect of [mist, flies]) {
      expect(effect.mesh.material.uniforms.uTime!.value).toBe(0)
    }
    expect(mist.mesh.material.uniforms.uDrift!.value.toArray()).toEqual([0, 0])
    expect(firstFly(flies)).toEqual(frozen)
    expect(flies.mesh.material.uniforms.uIntensity!.value).toBe(0.4)
    mist.dispose()
    flies.dispose()
  })

  it('releases GPU resources and removes both objects from the scene', () => {
    const scene = new Scene()
    const mist = new LakeMist(scene, lakeBed(), 0, false)
    const flies = new LakeFireflies(scene, lakeBed(), 0, false)
    const textureDispose = vi.fn<() => void>()
    mist.mesh.material.uniforms.uWater!.value.addEventListener('dispose', textureDispose)
    for (const effect of [mist, flies]) {
      const geometryDispose = vi.fn<() => void>(),
        materialDispose = vi.fn<() => void>()
      effect.mesh.geometry.addEventListener('dispose', geometryDispose)
      effect.mesh.material.addEventListener('dispose', materialDispose)
      effect.dispose()
      expect(geometryDispose).toHaveBeenCalledOnce()
      expect(materialDispose).toHaveBeenCalledOnce()
    }
    expect(textureDispose).toHaveBeenCalledOnce()
    expect(scene.children).toHaveLength(0)
  })
})
