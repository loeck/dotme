import { vec3 } from 'three/tsl'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { LakeCaustics } from './lake-caustics'
import { WindModel } from './wind'

describe('lake caustics node composition', () => {
  it('preserves previous material treatments and restores the owned graph', () => {
    const material = new MeshStandardNodeMaterial()
    const previous = vec3(0.3, 0.4, 0.5)
    material.colorNode = previous
    const caustics = new LakeCaustics()
    caustics.applyTo(material)
    const composed = material.colorNode
    expect(composed).not.toBe(previous)
    caustics.applyTo(material)
    expect(material.colorNode).toBe(composed)
    expect(material.emissiveNode).toBeNull()
    caustics.dispose()
    expect(material.colorNode).toBe(previous)
    material.dispose()
  })

  it('follows shared wind, fades with lighting, and freezes when motion is reduced', () => {
    const wind = new WindModel(12)
    const caustics = new LakeCaustics()
    caustics.update(10, wind.sample(10), 0.5, { x: 2, z: 3 })
    expect(caustics.uniforms.uCausticStrength.value).toBeCloseTo(0.85 * Math.sqrt(0.5))
    expect(caustics.uniforms.uTime.value).toBe(10)
    expect(caustics.uniforms.uWindRotation.value.toArray()).toEqual(wind.sample(10).rotation)
    expect(caustics.uniforms.uWindResponse.value.toArray()).toEqual(wind.sample(10).response)
    expect(caustics.uniforms.uCausticPointer.value.z).toBeGreaterThan(0)
    caustics.update(10.05, wind.sample(10.05), 0)
    expect(caustics.uniforms.uCausticStrength.value).toBe(0)
    // Sunrise ends the cursor's contribution without disabling solar caustics.
    caustics.update(10.1, wind.sample(10.1), 1, { x: 2, z: 3 }, 0)
    expect(caustics.uniforms.uCausticPointer.value.z).toBe(0)
    expect(caustics.uniforms.uCausticStrength.value).toBe(0.85)
    const still = new LakeCaustics(true)
    still.update(0, wind.sample(0), 0.5)
    still.update(100, wind.sample(100), 1, { x: 2, z: 3 })
    expect(still.uniforms.uTime.value).toBe(0)
    expect(still.uniforms.uWindRotation.value.toArray()).toEqual(wind.sample(0).rotation)
    expect(still.uniforms.uWindResponse.value.toArray()).toEqual(wind.sample(0).response)
    expect(still.uniforms.uCausticStrength.value).toBe(0.85)
    expect(still.uniforms.uCausticPointer.value.z).toBe(0)
  })
})
