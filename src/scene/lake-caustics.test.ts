import { MeshStandardMaterial, ShaderChunk, ShaderLib } from 'three'
import type { WebGLRenderer } from 'three'
import { describe, expect, it, vi } from 'vitest'

import { LakeCaustics } from './lake-caustics'
import { WIND_FIELD_GLSL } from './water-surface'
import { WindModel } from './wind'

describe('lake caustics material extension', () => {
  it('composes existing material hooks without adding illumination in shadow', () => {
    const material = new MeshStandardMaterial()
    const previous = vi.fn<MeshStandardMaterial['onBeforeCompile']>((shader) => {
      // The cloud-shadow hook expands this include before caustics run.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_begin>',
        ShaderChunk.lights_fragment_begin,
      )
    })
    material.onBeforeCompile = previous
    material.customProgramCacheKey = () => 'cloud-shadow'
    const caustics = new LakeCaustics()
    caustics.applyTo(material)
    caustics.applyTo(material)
    const shader = {
      vertexShader: ShaderLib.standard.vertexShader,
      fragmentShader: ShaderLib.standard.fragmentShader,
      uniforms: {},
    } as Parameters<MeshStandardMaterial['onBeforeCompile']>[0]
    material.onBeforeCompile(shader, {} as WebGLRenderer)
    expect(previous).toHaveBeenCalledOnce()
    expect(material.customProgramCacheKey()).toBe('cloud-shadow:lake-caustics-v2')
    expect(shader.fragmentShader).toContain('reflectedLight.directDiffuse *=')
    expect(shader.fragmentShader.indexOf('float causticFocus =')).toBeGreaterThan(0)
    expect(shader.fragmentShader.indexOf('float causticFocus =')).toBeLessThan(
      shader.fragmentShader.indexOf('reflectedLight.directDiffuse *='),
    )
    expect(shader.fragmentShader).not.toContain('totalEmissiveRadiance +=')
    expect(shader.vertexShader).toContain('instanceMatrix * causticWorld')
    caustics.dispose()
    expect(material.onBeforeCompile).toBe(previous)
    expect(material.customProgramCacheKey()).toBe('cloud-shadow')
    material.dispose()
  })

  it('keeps selected wave phases and packets identical to the rendered surface', () => {
    const material = new MeshStandardMaterial()
    const caustics = new LakeCaustics()
    caustics.applyTo(material)
    const shader = {
      vertexShader: ShaderLib.standard.vertexShader,
      fragmentShader: ShaderLib.standard.fragmentShader,
      uniforms: {},
    } as Parameters<MeshStandardMaterial['onBeforeCompile']>[0]
    material.onBeforeCompile(shader, {} as WebGLRenderer)
    // This contract catches drift if the shared surface phase/envelope changes;
    // equal clocks alone did not keep the old independent caustic field in sync.
    for (const declaration of [
      'vec2 k',
      'float crossPhase',
      'float phase',
      'vec2 phaseGradient',
      'float groupPhase',
      'float alongPacket',
      'float crossPacket',
      'vec2 packetGradient',
      'float strength',
    ]) {
      const pattern = new RegExp(`${declaration} = [^;]+;`, 'g')
      const surface = WIND_FIELD_GLSL.match(pattern)!.map((line) => line.replace(/\s+/g, ' '))
      const caustic = shader.fragmentShader.match(pattern)!.map((line) => line.replace(/\s+/g, ' '))
      expect(caustic).toHaveLength(5)
      for (const line of caustic) expect(surface).toContain(line)
    }
    expect(shader.fragmentShader).not.toContain('uCausticDrift')
    expect(shader.fragmentShader).not.toContain('pointerWave')
    expect(shader.fragmentShader.match(/lakeCausticLight\(vCausticWorld\)/g)).toHaveLength(1)
    caustics.dispose()
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
