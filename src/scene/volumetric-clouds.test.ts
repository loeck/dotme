import { WebGPUCoordinateSystem } from 'three/webgpu'
import type { RenderTarget } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import type { CloudRenderer } from './cloud-shadows'
import { sampleLighting } from './lighting'
import { VolumetricClouds, sampleCloudDisplacement } from './volumetric-clouds'
import { WindModel } from './wind'

function fixture() {
  let target: RenderTarget | null = null,
    face = 0
  const captures = new Map<unknown, number[]>()
  let captureTime = 0
  const renderer: CloudRenderer = {
    coordinateSystem: WebGPUCoordinateSystem,
    autoClear: true,
    xr: { enabled: false },
    getScissorTest: () => false,
    setScissorTest: () => undefined,
    getRenderTarget: () => target,
    getActiveCubeFace: () => face,
    getActiveMipmapLevel: () => 0,
    setRenderTarget(next: RenderTarget | null, nextFace = 0) {
      target = next
      face = nextFace
    },
    compileAsync: async () => undefined,
    render() {
      if (!target || !('isCubeRenderTarget' in target)) return
      const parts = captures.get(target.texture) ?? []
      parts[face] = captureTime
      captures.set(target.texture, parts)
    },
  }
  const clouds = new VolumetricClouds(
    renderer,
    12,
    false,
    new WindModel(12),
    (time) => {
      captureTime = time
      return sampleLighting(0, time)
    },
    undefined,
    new Uint8Array(32 ** 3 * 2),
  )
  return { clouds, captures }
}

describe('progressive cloud captures', () => {
  it('keeps clouds moving in calm weather without changing strong-wind travel', () => {
    for (const meanSpeed of [0, 0.64, 6]) {
      const wind = new WindModel(42, { meanSpeed, bearing: 0.7, gustStrength: 0, turnStrength: 0 })
      expect(sampleCloudDisplacement(wind, 0)).toEqual([0, 0])
      const [x, z] = sampleCloudDisplacement(wind, 10)
      expect(Math.hypot(x, z)).toBeCloseTo(Math.max(meanSpeed, 2.2) * 10)
      expect(Math.atan2(z, x)).toBeCloseTo(0.7)
      const after = sampleCloudDisplacement(wind, 10.001)
      expect(Math.hypot(after[0] - x, after[1] - z)).toBeLessThan(0.007)
    }
  })

  it.each([15, 30, 60, 144])('publishes complete bracketing timestamps at %i fps', (fps) => {
    const { clouds, captures } = fixture()
    for (const time of [...Array.from({ length: fps }, (_, i) => i / fps), 25, 0, 3.123]) {
      clouds.update(time)
      const tick = Math.floor(time * 15)
      expect(captures.get(clouds.uniforms.uCloudPrevious.value)).toEqual(Array(6).fill(tick / 15))
      expect(captures.get(clouds.uniforms.uCloudNext.value)).toEqual(Array(6).fill((tick + 1) / 15))
      expect(clouds.uniforms.uCloudBlend.value).toBeCloseTo(time * 15 - tick, 10)
      expect(clouds.shadows.uniforms.uCloudShadowNextOffset.value).not.toBe(
        clouds.shadows.uniforms.uCloudShadowPreviousOffset.value,
      )
    }
    clouds.dispose()
  })
})
