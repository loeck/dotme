import { asin, atan, clamp, exp, max, mix, smoothstep, vec2, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'

import { horizonNoise } from './distant-horizon'

/** Share of landscapes (seeds) whose clear nights carry an aurora. */
export const AURORA_SHARE = 0.3

/**
 * Whether a landscape's nights have an aurora: rare, but fixed by the seed so a shared link
 * shows the same sky. An integer hash spreads neighbouring seeds apart.
 */
export function hasAurora(seed: number) {
  let h = Math.imul((seed >>> 0) ^ 0x9e37_79b9, 0x85eb_ca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2_ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4_294_967_296 < AURORA_SHARE
}

export type AuroraUniforms = Readonly<{
  uAurora: Node<'float'>
  uSeed: Node<'float'>
  uStarTime: Node<'float'>
  uSunDirection: Node<'vec3'>
}>

/**
 * Aurora curtains low over the far shore, right of the frame's centre so they balance the Milky
 * Way on the left. A wavy base line folds slowly; fine vertical rays drift along it. Oxygen
 * green at the lower edge turns to a faint violet higher up, as the emission lines do with
 * altitude. It only appears in full night, and the clouds in front of it hide it.
 */
export function aurora(direction: Node<'vec3'>, u: AuroraUniforms) {
  const azimuth = atan(direction.x, direction.z.negate())
  const elevation = asin(clamp(direction.y, -1, 1))
  const t = u.uStarTime
  const seed = u.uSeed
  // Where along the horizon the arc stands: strongest a little right of the view.
  const footprint = exp(azimuth.sub(0.35).div(0.75).pow2().negate())
  // Two scales of folding: a broad sway of the arc and tighter pleats in the curtain.
  const fold = horizonNoise(vec2(azimuth.mul(1.6).add(t.mul(0.012)), seed.add(31)))
    .mul(0.7)
    .add(horizonNoise(vec2(azimuth.mul(5.5).sub(t.mul(0.02)), seed.add(43))).mul(0.3))
  const base = fold.sub(0.5).mul(0.16).add(0.13)
  const height = elevation.sub(base)
  // Sharp lower edge, long fading rays above it.
  const curtain = smoothstep(-0.012, 0.012, height).mul(exp(max(height, 0).div(0.11).negate()))
  // Rays follow the folds, so they bend with the curtain rather than standing as a comb.
  const rayCoord = azimuth.mul(46).add(fold.mul(9)).add(t.mul(0.05))
  const rays = horizonNoise(vec2(rayCoord, seed.add(5)))
    .mul(0.6)
    .add(horizonNoise(vec2(rayCoord.mul(2.7), seed.add(9))).mul(0.4))
    .pow(1.6)
  // Slow brightening and fading along the arc.
  const surge = smoothstep(
    0.25,
    0.85,
    horizonNoise(vec2(azimuth.mul(2.4).sub(t.mul(0.02)), seed.add(77))),
  )
    .mul(1.1)
    .add(0.15)
  const colour = mix(vec3(0.12, 1, 0.42), vec3(0.6, 0.22, 0.8), smoothstep(0.03, 0.22, height))
  const night = smoothstep(0.12, 0.3, u.uSunDirection.y.negate())
  return colour
    .mul(curtain.mul(rays.mul(1.4).add(0.3)))
    .mul(footprint)
    .mul(surge)
    .mul(smoothstep(0.0, 0.06, direction.y))
    .mul(night)
    .mul(u.uAurora)
    .mul(0.09)
}
