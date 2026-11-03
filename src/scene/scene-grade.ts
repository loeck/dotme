import {
  clamp,
  dot,
  float,
  interleavedGradientNoise,
  max,
  mix,
  pow,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { Vector2, Vector3 } from 'three/webgpu'
import type { Node } from 'three/webgpu'

import type { SceneLook } from './scene-look'

const REC709 = vec3(0.2126, 0.7152, 0.0722)
/** Contrast pivots on scene middle grey so black stays black and highlights roll into ACES. */
const MIDDLE_GREY = 0.18

/** Last Signal's grade: HDR exposure, white balance, contrast, saturation and vignette before
 * tone mapping; film grain and dither after it, in display space. */
export class SceneGrade {
  private readonly exposure = uniform(1)
  private readonly contrast = uniform(1)
  private readonly saturation = uniform(1)
  private readonly tint = uniform(new Vector3(1, 1, 1))
  private readonly vignette = uniform(0)
  private readonly grain = uniform(0)
  private readonly frame = uniform(0)
  private readonly aspect = uniform(new Vector2(1, 1))
  private readonly pixels = uniform(new Vector2(1, 1))

  update(look: SceneLook, frame: number) {
    this.exposure.value = look.exposure
    this.contrast.value = look.contrast
    this.saturation.value = look.saturation
    this.tint.value.set(...look.tint)
    this.vignette.value = look.vignette
    this.grain.value = look.grain
    // Reduced motion keeps one still grain pattern rather than a flickering one.
    this.frame.value = frame % 64
  }

  /** Drawing-buffer size: grain is addressed per device pixel. */
  resize(width: number, height: number) {
    const long = Math.max(width, height, 1)
    this.aspect.value.set(width / long, height / long)
    this.pixels.value.set(Math.max(1, width), Math.max(1, height))
  }

  /** Linear HDR grade, shared by the lens and by the profile's contrast mask. */
  colour(radiance: Node<'vec3'>): Node<'vec3'> {
    const exposed = radiance.mul(this.tint).mul(this.exposure)
    const luminance = max(dot(exposed, REC709), 0.00001)
    const contrasted = exposed.mul(pow(luminance.div(MIDDLE_GREY), this.contrast.sub(1)))
    const grey = dot(contrasted, REC709)
    return max(mix(vec3(grey), contrasted, this.saturation), vec3(0))
  }

  /** Vignette after the colour grade, measured on the long axis so it stays round. */
  frameEdge(coord: Node<'vec2'>): Node<'float'> {
    const offset = coord.sub(0.5).mul(this.aspect).mul(2)
    return float(1).sub(this.vignette.mul(smoothstep(0.55, 1.35, offset.length())))
  }

  /** Display-space grain, strongest in midtones, plus ±½ LSB dither against banding.
   * Pixels come from the pass's canonical top-left UVs, not the fragment coordinate, whose
   * vertical origin differs between WebGPU and WebGL: both backends get the same pattern. */
  finish(display: Node<'vec4'>): Node<'vec4'> {
    const pixel = uv().mul(this.pixels).floor().add(0.5)
    const grainNoise = interleavedGradientNoise(pixel.add(this.frame.mul(5.588238)))
    const ditherNoise = interleavedGradientNoise(pixel.add(vec2(47, 17)).add(this.frame.mul(7.13)))
    const luminance = clamp(dot(display.rgb, REC709), 0, 1)
    const grain = grainNoise
      .sub(0.5)
      .mul(this.grain)
      .mul(luminance.mul(luminance.oneMinus()).mul(8))
    const dither = ditherNoise.sub(0.5).div(255)
    return vec4(display.rgb.add(grain).add(dither), display.a)
  }
}
