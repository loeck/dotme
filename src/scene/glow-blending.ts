import { AddEquation, CustomBlending, OneFactor, SrcAlphaFactor, ZeroFactor } from 'three/webgpu'

/**
 * Additive light (a lamp's halo, fireflies, the shockwave ring) that leaves the target's alpha
 * alone. Three's AdditiveBlending also adds the source alpha, and the lake reads the reflection
 * target's alpha as scenery coverage (sky shows through 1 − alpha): every glow quad reflected
 * against the sky cut a black square out of it, the size of the quad.
 */
export const GLOW_BLENDING = {
  blending: CustomBlending,
  blendEquation: AddEquation,
  blendSrc: SrcAlphaFactor,
  blendDst: OneFactor,
  blendEquationAlpha: AddEquation,
  blendSrcAlpha: ZeroFactor,
  blendDstAlpha: OneFactor,
} as const
