import { dot, exp, float, max, smoothstep, vec2, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'

/**
 * Ghosts a camera lens throws along the line from the sun through the frame's centre: each
 * sits at `at` times the sun's offset from the centre (negative: across the centre), with a
 * radius in frame heights and a faint tint from the lens coatings.
 */
export const GHOSTS: readonly Readonly<{ at: number; radius: number; tint: readonly number[] }>[] =
  [
    { at: 0.55, radius: 0.022, tint: [1, 0.62, 0.25] },
    { at: 0.2, radius: 0.04, tint: [0.35, 0.85, 0.7] },
    { at: -0.3, radius: 0.06, tint: [0.55, 0.45, 1] },
    { at: -0.7, radius: 0.03, tint: [1, 0.55, 0.3] },
    { at: -1.15, radius: 0.085, tint: [0.35, 0.6, 1] },
  ]

/** Brightness of each ghost relative to the flare's strength, in exposed radiance units. */
const GHOST_GAIN = 0.8

/**
 * How strongly the sun flares the lens: only while its disc is in or just outside the frame
 * (fading over the last 30% beyond the edge) and the sun is up, a little more when it is low
 * and its light is long. Whether trees, ridges or cloud hide the disc is the caller's to apply.
 */
export function flareStrength(
  ndc: Readonly<{ x: number; y: number; z: number }>,
  sunHeight: number,
) {
  if (!Number.isFinite(ndc.x + ndc.y + ndc.z) || ndc.z > 1 || ndc.z < -1) return 0
  const edge = Math.max(Math.abs(ndc.x), Math.abs(ndc.y))
  const inFrame = 1 - Math.min(1, Math.max(0, (edge - 1) / 0.3))
  const up = Math.min(1, Math.max(0, sunHeight / 0.04))
  const low = 1 + 0.6 * (1 - Math.min(1, Math.max(0, sunHeight / 0.5)))
  return inFrame * up * low
}

/**
 * The flare at screen coordinate `coord` (UV), for a sun at `sun` (UV), with `aspect` the
 * frame's width over its height.
 */
export function lensFlare(
  coord: Node<'vec2'>,
  sun: Node<'vec2'>,
  strength: Node<'float'>,
  aspect: Node<'float'>,
) {
  const centre = vec2(0.5, 0.5)
  const offset = sun.sub(centre)
  let sum: Node<'vec3'> = vec3(0)
  for (const ghost of GHOSTS) {
    const position = centre.add(offset.mul(ghost.at))
    const d = coord.sub(position).mul(vec2(aspect, 1))
    const r2 = dot(d, d).div(ghost.radius * ghost.radius)
    // A soft disc with a slightly brighter rim, as an iris-shaped ghost has.
    const disc = smoothstep(1, 0.75, r2).mul(r2.mul(0.5).add(0.5))
    sum = sum.add(vec3(...ghost.tint).mul(disc))
  }
  // Ghosts fade as the sun nears the centre, where they collapse onto it.
  const spread = smoothstep(0.02, 0.15, offset.length())
  const halo = exp(coord.sub(sun).mul(vec2(aspect, 1)).length().mul(-9)).mul(0.25)
  return sum
    .mul(spread)
    .add(vec3(1, 0.85, 0.62).mul(halo))
    .mul(max(float(0), strength).mul(GHOST_GAIN))
}
