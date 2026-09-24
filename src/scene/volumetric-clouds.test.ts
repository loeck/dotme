import { WebGLCoordinateSystem } from 'three'
import type { Scene, WebGLRenderer, WebGLRenderTarget } from 'three'
import { describe, expect, it } from 'vitest'

import { VolumetricClouds } from './volumetric-clouds'
import { WindModel } from './wind'

function fixture() {
  let target: WebGLRenderTarget | null = null,
    face = 0
  const captures = new Map<unknown, number[]>()
  const renderer = {
    extensions: { has: () => false },
    coordinateSystem: WebGLCoordinateSystem,
    xr: { enabled: false },
    state: { buffers: { depth: { getReversed: () => false } } },
    getRenderTarget: () => target,
    getActiveCubeFace: () => face,
    getActiveMipmapLevel: () => 0,
    setRenderTarget(next: WebGLRenderTarget | null, nextFace = 0) {
      target = next
      face = nextFace
    },
    render(scene: Scene) {
      const object = scene.children[0] as unknown as {
        material: { uniforms: { uTime: { value: number } } }
      }
      if (!target || !('isWebGLCubeRenderTarget' in target)) return
      const parts = captures.get(target.texture) ?? []
      parts[face] = object.material.uniforms.uTime.value
      captures.set(target.texture, parts)
    },
  } as unknown as WebGLRenderer
  const clouds = new VolumetricClouds(
    renderer,
    12,
    false,
    new WindModel(12),
    new Uint8Array(32 ** 3 * 2),
  )
  return { clouds, captures }
}

describe('progressive cloud captures', () => {
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
