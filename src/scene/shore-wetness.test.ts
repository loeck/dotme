import { vec3 } from 'three/tsl'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { ShoreWetness, advanceShoreWetness } from './shore-wetness'

describe('rain retained by shore stone', () => {
  it('soaks quickly and retains a visible trace while drying slowly', () => {
    const soaked = advanceShoreWetness(0, 1, 20)
    expect(soaked).toBeGreaterThan(0.9)
    const afterRain = advanceShoreWetness(soaked, 0, 20)
    expect(afterRain).toBeGreaterThan(0.8)
    expect(afterRain).toBeLessThan(soaked)
    expect(advanceShoreWetness(afterRain, 0, 600)).toBeLessThan(0.03)
  })

  it('integrates rain transitions consistently at every frame rate', () => {
    const timeline = [
      { seconds: 10, rain: 0.35 },
      { seconds: 15, rain: 1 },
      { seconds: 40, rain: 0 },
    ]
    let reference = 0
    for (const { seconds, rain } of timeline)
      reference = advanceShoreWetness(reference, rain, seconds)
    for (const hz of [30, 60, 144]) {
      let wetness = 0
      for (const { seconds, rain } of timeline)
        for (let frame = 0; frame < seconds * hz; frame++)
          wetness = advanceShoreWetness(wetness, rain, 1 / hz)
      expect(wetness).toBeCloseTo(reference, 11)
    }
  })

  it('bounds arbitrary public inputs and ignores invalid elapsed times', () => {
    expect(advanceShoreWetness(0, 9, 1000)).toBe(1)
    expect(advanceShoreWetness(1, -9, 1000)).toBeGreaterThanOrEqual(0)
    expect(advanceShoreWetness(0.5, 1, -1)).toBe(0.5)
    expect(advanceShoreWetness(0.5, 1, Infinity)).toBe(0.5)
    expect(advanceShoreWetness(NaN, NaN, 1)).toBe(0)
  })

  it('composes color and roughness nodes and restores the previous treatment', () => {
    const material = new MeshStandardNodeMaterial({ color: 0x263742, roughness: 0.42 })
    const previous = vec3(0.2, 0.3, 0.4)
    material.colorNode = previous
    const color = material.color.clone()
    const wetness = new ShoreWetness(0.65)
    wetness.applyTo(material)
    const composed = material.colorNode
    wetness.applyTo(material)
    expect(material.colorNode).toBe(composed)
    expect(material.colorNode).not.toBe(previous)
    wetness.update(10, 1)
    expect(wetness.wetness).toBeGreaterThan(0.65)
    expect(material.roughness).toBe(0.42)
    expect(material.color).toEqual(color)
    wetness.dispose()
    expect(material.colorNode).toBe(previous)
    expect(material.roughnessNode).toBeNull()
    expect(wetness.wetness).toBe(0)
    material.dispose()
  })
})
