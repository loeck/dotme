import { float, texture, vec2 } from 'three/tsl'
import type { DepthTexture, Node } from 'three/webgpu'

/** Tap offsets in shadow-map texels: a 3×3 grid, or its centre and corners on low power. */
const GRID: readonly (readonly [number, number])[] = [-1, 0, 1].flatMap((y) =>
  [-1, 0, 1].map((x) => [x, y] as const),
)
const CORNERS: readonly (readonly [number, number])[] = [
  [0, 0],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
]

type ShadowFilterInputs = Readonly<{ depthTexture: DepthTexture; shadowCoord: Node<'vec3'> }>

/**
 * PCF over a fixed pattern of hardware-filtered (bilinear) comparisons. Three's default PCF
 * rotates five taps by interleaved gradient noise in screen space, so each pixel's pattern stays
 * on the screen while shadow edges slide under it: edges shimmer whenever the view or the light
 * moves quickly. A fixed pattern is anchored to the shadow map instead, and with the bilinear
 * compare the grid gives a smooth edge about three texels wide rather than a dithered one.
 */
export function stableShadowFilter(mapSize: number, lowPower: boolean) {
  const texel = 1 / mapSize
  const offsets = lowPower ? CORNERS : GRID
  const weight = 1 / offsets.length
  return ({ depthTexture, shadowCoord }: ShadowFilterInputs): Node<'float'> => {
    let sum: Node<'float'> = float(0)
    for (const [x, y] of offsets)
      // A depth comparison is a scalar, which `.x` leaves as is; the typings call it a vec4.
      sum = sum.add(
        texture(depthTexture, shadowCoord.xy.add(vec2(x * texel, y * texel))).compare(shadowCoord.z)
          .x,
      )
    return sum.mul(weight)
  }
}
