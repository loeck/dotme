import { float, vec3 } from 'three/tsl'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { LakeSand } from './lake-sand'

describe('lake sand ripple composition', () => {
  it('preserves previous material treatments and restores the owned graph', () => {
    const material = new MeshStandardNodeMaterial()
    const previous = vec3(0.3, 0.4, 0.5)
    const previousNormal = vec3(0, 1, 0)
    const previousRoughness = float(0.8)
    material.colorNode = previous
    material.normalNode = previousNormal
    material.roughnessNode = previousRoughness
    const sand = new LakeSand(12)
    sand.applyTo(material)
    const composed = material.colorNode
    expect(composed).not.toBe(previous)
    expect(material.normalNode).not.toBe(previousNormal)
    expect(material.roughnessNode).not.toBe(previousRoughness)
    sand.applyTo(material)
    expect(material.colorNode).toBe(composed)
    expect(material.emissiveNode).toBeNull()
    sand.dispose()
    expect(material.colorNode).toBe(previous)
    expect(material.normalNode).toBe(previousNormal)
    expect(material.roughnessNode).toBe(previousRoughness)
    material.dispose()
  })
})
