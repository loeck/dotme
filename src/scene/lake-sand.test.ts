import { vec3 } from 'three/tsl'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { LakeSand } from './lake-sand'

describe('lake sand ripple composition', () => {
  it('preserves previous material treatments and restores the owned graph', () => {
    const material = new MeshStandardNodeMaterial()
    const previous = vec3(0.3, 0.4, 0.5)
    material.colorNode = previous
    const sand = new LakeSand(12)
    sand.applyTo(material)
    const composed = material.colorNode
    expect(composed).not.toBe(previous)
    sand.applyTo(material)
    expect(material.colorNode).toBe(composed)
    expect(material.emissiveNode).toBeNull()
    sand.dispose()
    expect(material.colorNode).toBe(previous)
    material.dispose()
  })
})
