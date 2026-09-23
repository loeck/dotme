import { describe, expect, it } from 'vitest'

import { createCloudBodies } from './cloud-density'
import { createCloudNoise, periodicNoise } from './cloud-noise'
import { sampleWindField, swellHeight } from './water-surface'
import { WIND_BEARING, WindModel } from './wind'

const h = 0.00001

describe('shared atmospheric wind', () => {
  it('is seeded, positive, continuous and independent of sampling history', () => {
    const wind = new WindModel(9182)
    expect(wind.sample(0).displacement).toEqual([0, 0])
    expect(wind.sample(15)).toEqual(new WindModel(9182).sample(15))
    expect(wind.sample(15)).not.toEqual(new WindModel(12).sample(15))
    for (const hz of [30, 60, 144]) {
      for (let i = 0; i < hz * 10; i++) wind.sample(i / hz)
      expect(wind.sample(10)).toEqual(new WindModel(9182).sample(10))
    }
    for (let t = 0; t <= 600; t += 0.73) {
      const state = wind.sample(t)
      expect(state.speed).toBeGreaterThan(1.7)
      expect(state.speed).toBeLessThan(6.01)
      const before = wind.sample(t - h),
        after = wind.sample(t + h)
      for (let axis = 0; axis < 2; axis++) {
        expect((after.displacement[axis]! - before.displacement[axis]!) / (2 * h)).toBeCloseTo(
          state.direction[axis]! * state.speed,
          6,
        )
        expect((after.response[axis]! - before.response[axis]!) / (2 * h)).toBeCloseTo(
          state.response[axis + 2]!,
          7,
        )
      }
      expect((after.rotation[0] - before.rotation[0]) / (2 * h)).toBeCloseTo(
        -state.rotation[1] * state.rotationVelocity,
        7,
      )
      expect((after.rotation[1] - before.rotation[1]) / (2 * h)).toBeCloseTo(
        state.rotation[0] * state.rotationVelocity,
        7,
      )
    }
  })

  it('veers both left and right smoothly and handles still air', () => {
    for (const seed of [0, 12, 9182]) {
      const wind = new WindModel(seed)
      const states = Array.from({ length: 600 }, (_, t) => wind.sample(t))
      expect(Math.min(...states.map((s) => s.direction[0]))).toBeLessThan(-0.1)
      expect(Math.max(...states.map((s) => s.direction[0]))).toBeGreaterThan(0.9)
      expect(Math.max(...states.map((s) => Math.abs(s.rotationVelocity)))).toBeLessThan(0.1)
    }
    const calm = new WindModel(9182, { meanSpeed: 0 }).sample(42)
    expect(calm.speed).toBe(0)
    expect(calm.rotationVelocity).toBe(0)
    expect(calm.response).toEqual([0, 0, 0, 0])
    // Without crosswind, the vector filters reduce to scalar first-order lags.
    const straight = new WindModel(12, { turnStrength: 0 })
    for (let t = 0; t < 100; t += 0.73) {
      const state = straight.sample(t)
      expect(state.response[2]).toBeCloseTo((state.speed / 3 - state.response[0]) / 8, 10)
      expect(state.response[3]).toBeCloseTo((state.speed / 3 - state.response[1]) / 2.5, 10)
    }
  })

  it('keeps surface gradients and foam velocity equal to finite differences during gusts', () => {
    for (const seed of [0, 12, 9182]) {
      const wind = new WindModel(seed)
      for (const time of [0, 13.4, 57.1]) {
        const state = wind.sample(time)
        const field = sampleWindField(3.7, -17.3, time, state)
        expect(field[1]).toBeCloseTo(
          (swellHeight(3.7 + h, -17.3, time, state) - swellHeight(3.7 - h, -17.3, time, state)) /
            (2 * h),
          7,
        )
        expect(field[2]).toBeCloseTo(
          (swellHeight(3.7, -17.3 + h, time, state) - swellHeight(3.7, -17.3 - h, time, state)) /
            (2 * h),
          7,
        )
        expect(field[3]).toBeCloseTo(
          (swellHeight(3.7, -17.3, time + h, wind.sample(time + h)) -
            swellHeight(3.7, -17.3, time - h, wind.sample(time - h))) /
            (2 * h),
          7,
        )
      }
    }
  })

  it('reverses advection and wave orientation with one bearing, and strengthens short waves', () => {
    const forward = new WindModel(12).sample(7)
    const reverse = new WindModel(12, { bearing: WIND_BEARING + Math.PI }).sample(7)
    expect(reverse.displacement[0]).toBeCloseTo(-forward.displacement[0], 10)
    expect(reverse.displacement[1]).toBeCloseTo(-forward.displacement[1], 10)
    expect(swellHeight(3, -2, 7, reverse)).toBeCloseTo(swellHeight(-3, 2, 7, forward), 10)
    let weakEnergy = 0,
      strongEnergy = 0
    const weak = new WindModel(12, { meanSpeed: 0.6, gustStrength: 0 }).sample(0)
    const strong = new WindModel(12, { meanSpeed: 6, gustStrength: 0 }).sample(0)
    for (let x = 0; x < 100; x++) {
      weakEnergy += sampleWindField(x, -3, 0, weak)[1]! ** 2
      strongEnergy += sampleWindField(x, -3, 0, strong)[1]! ** 2
    }
    expect(strongEnergy).toBeGreaterThan(weakEnergy * 2)
  })

  it('seeds independently moving small clouds and large banks', () => {
    for (const seed of [0, 12, 9182]) {
      const bodies = createCloudBodies(seed)
      expect(bodies).toEqual(createCloudBodies(seed))
      expect(bodies).not.toEqual(createCloudBodies(seed + 1))
      const speeds = bodies.uCloudOrigins.value.map((body) => body.w)
      const sizes = bodies.uCloudRadii.value.map((body) => body.x)
      expect(new Set(speeds).size).toBe(speeds.length)
      expect(Math.max(...speeds) - Math.min(...speeds)).toBeGreaterThan(0.5)
      expect(Math.max(...sizes) / Math.min(...sizes)).toBeGreaterThan(3)
    }
  })

  it('generates reproducible 3D textures and continuous periodic noise', () => {
    const a = createCloudNoise(9182, 8),
      b = createCloudNoise(9182, 8),
      c = createCloudNoise(12, 8)
    expect(a.image.data).toEqual(b.image.data)
    expect(a.image.data).not.toEqual(c.image.data)
    for (const p of [
      [0.3, 2.7, -1.1],
      [-0.001, 0, 4],
    ]) {
      const [x, y, z] = p as [number, number, number]
      const n = periodicNoise(x, y, z, 12, 4)
      expect(periodicNoise(x + 4, y, z, 12, 4)).toBeCloseTo(n, 12)
      expect(periodicNoise(x, y + 4, z, 12, 4)).toBeCloseTo(n, 12)
      expect(periodicNoise(x, y, z + 4, 12, 4)).toBeCloseTo(n, 12)
    }
    a.dispose()
    b.dispose()
    c.dispose()
  })
})
