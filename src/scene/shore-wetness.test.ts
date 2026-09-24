import { MeshStandardMaterial, ShaderLib } from 'three'
import type { WebGLRenderer } from 'three'
import { describe, expect, it, vi } from 'vitest'

import { ShoreWetness, advanceShoreWetness } from './shore-wetness'

const existingCacheKey = () => 'existing-lighting'

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

  it('composes existing lighting hooks, preserves base material and restores owned hooks', () => {
    const material = new MeshStandardMaterial({ color: 0x263742, roughness: 0.42 })
    const previousCompile = vi.fn<MeshStandardMaterial['onBeforeCompile']>((shader) => {
      shader.uniforms.uExistingLighting = { value: 7 }
    })
    material.onBeforeCompile = previousCompile
    material.customProgramCacheKey = existingCacheKey
    const color = material.color.clone()
    const wetness = new ShoreWetness(0.65)
    wetness.applyTo(material)
    wetness.applyTo(material)
    const shader = {
      uniforms: {},
      vertexShader: ShaderLib.standard.vertexShader,
      fragmentShader: ShaderLib.standard.fragmentShader,
    } as Parameters<MeshStandardMaterial['onBeforeCompile']>[0]
    material.onBeforeCompile(shader, {} as WebGLRenderer)
    expect(previousCompile).toHaveBeenCalledOnce()
    expect(shader.uniforms.uExistingLighting!.value).toBe(7)
    expect(shader.uniforms.uShoreWetness!.value).toBe(0.65)
    expect(material.customProgramCacheKey()).toContain('existing-lighting')
    wetness.update(10, 1)
    expect(shader.uniforms.uShoreWetness!.value).toBeGreaterThan(0.65)
    expect(material.roughness).toBe(0.42)
    expect(material.color).toEqual(color)
    wetness.dispose()
    expect(material.onBeforeCompile).toBe(previousCompile)
    expect(material.customProgramCacheKey).toBe(existingCacheKey)
    expect(shader.uniforms.uShoreWetness!.value).toBe(0)
    material.dispose()
  })
})
