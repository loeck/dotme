import { exp, float, fract, max, mix, sin, smoothstep, vec2, vec3, atan } from 'three/tsl'
import type { Node } from 'three/webgpu'

const hash = (v: Node<'vec2'>) => fract(sin(v.dot(vec2(127.1, 311.7))).mul(43758.5453))
export function horizonNoise(p: Node<'vec2'>) {
  const i = p.floor(),
    f0 = fract(p),
    f = f0.mul(f0).mul(float(3).sub(f0.mul(2)))

  return mix(
    mix(hash(i), hash(i.add(vec2(1, 0))), f.x),
    mix(hash(i.add(vec2(0, 1))), hash(i.add(1)), f.x),
    f.y,
  )
}
export function distantPeaks(azimuth: Node<'float'>, seed: Node<'float'>, mobile: Node<'float'>) {
  const ridge = (centre: number, width: number, height: number) =>
    exp(azimuth.sub(centre).div(width).pow2().negate()).mul(height)
  const farMobile = max(ridge(-0.165, 0.105, 0.072), ridge(0.185, 0.112, 0.067)).add(0.004)
  const middleMobile = max(
    ridge(-0.197, 0.073, 0.047),
    max(ridge(0.135, 0.075, 0.043), ridge(0.066, 0.048, 0.028)),
  ).add(0.002)
  const nearMobile = max(ridge(-0.215, 0.065, 0.034), ridge(0.215, 0.061, 0.028))
  const farDesktop = max(
    max(ridge(-0.64, 0.32, 0.108), ridge(-0.32, 0.17, 0.075)),
    max(max(ridge(0.47, 0.27, 0.108), ridge(0.75, 0.13, 0.052)), ridge(0.035, 0.12, 0.038)),
  ).add(0.005)
  const middleDesktop = max(
    max(ridge(-0.72, 0.24, 0.078), ridge(-0.235, 0.14, 0.052)),
    max(max(ridge(0.42, 0.2, 0.067), ridge(0.71, 0.14, 0.066)), ridge(0.16, 0.095, 0.037)),
  ).add(0.004)
  const nearDesktop = max(
    max(ridge(-0.57, 0.18, 0.052), ridge(-0.27, 0.12, 0.032)),
    max(ridge(0.55, 0.14, 0.053), ridge(0.28, 0.15, 0.03)),
  )
  const detail = horizonNoise(vec2(azimuth.mul(18).add(seed), 4.7))
    .mul(0.6)
    .add(horizonNoise(vec2(azimuth.mul(52), seed.add(8))).mul(0.3))
    .add(horizonNoise(vec2(azimuth.mul(109), seed.add(3))).mul(0.1))
  return vec3(
    mix(farDesktop, farMobile, mobile).add(detail.sub(0.5).mul(0.031)),
    mix(middleDesktop, middleMobile, mobile).add(
      horizonNoise(vec2(azimuth.mul(38).sub(seed), 22.1))
        .sub(0.5)
        .mul(0.024),
    ),
    mix(nearDesktop, nearMobile, mobile).add(
      horizonNoise(vec2(azimuth.mul(54).add(seed), 53.9))
        .sub(0.5)
        .mul(0.016),
    ),
  )
}
export function distantLightVisibility(
  direction: Node<'vec3'>,
  seed: Node<'float'>,
  mobile: Node<'float'>,
) {
  const peaks = distantPeaks(atan(direction.x, direction.z.negate()), seed, mobile)
  const crest = max(0, max(peaks.x, max(peaks.y, peaks.z)))
  return smoothstep(crest.sub(0.009), crest.add(0.009), direction.y)
}
