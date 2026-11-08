import { CustomBlending, MeshBasicNodeMaterial, OneFactor, ZeroFactor } from 'three/webgpu'
import { expect, it } from 'vitest'

import { GLOW_BLENDING } from './glow-blending'

it('adds light without writing coverage into the reflection alpha', () => {
  const material = new MeshBasicNodeMaterial({ transparent: true, ...GLOW_BLENDING })
  expect(material.blending).toBe(CustomBlending)
  expect(material.blendDst).toBe(OneFactor)
  // The destination alpha is kept as is: the lake reads it as scenery coverage.
  expect(material.blendSrcAlpha).toBe(ZeroFactor)
  expect(material.blendDstAlpha).toBe(OneFactor)
  material.dispose()
})
