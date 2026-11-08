import { float, sin, smoothstep } from 'three/tsl'
import type { Node } from 'three/webgpu'

/**
 * Gusts the weather brings by itself: broad patches of stronger wind that roll across the wood
 * downwind, so crowns lean in waves rather than all swaying together. They come in spells of a
 * few tens of seconds with calmer lulls between. The vegetation's sway and the falling leaves
 * read the same field: `ambientGust` here and `ambientGustNode` in the shaders.
 */
export const AMBIENT_GUST = {
  /** Distance between two patch fronts along the wind, metres. */
  wavelength: 55,
  /** Speed the patches roll downwind, metres per second. */
  speed: 9,
} as const

const K = (2 * Math.PI) / AMBIENT_GUST.wavelength

function smooth(edge0: number, edge1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** How gusty the weather is at `time`, 0 in a lull to 1 in a squally spell. */
export function gustSpell(time: number) {
  return smooth(
    -0.25,
    0.75,
    0.6 * Math.sin(time * 0.081 + 0.4) + 0.4 * Math.sin(time * 0.029 + 2.1),
  )
}

/** Ambient gust strength, 0–1, at world (x, z) for a wind blowing along the unit (dx, dz). */
export function ambientGust(x: number, z: number, time: number, dx: number, dz: number) {
  const along = x * dx + z * dz,
    across = z * dx - x * dz
  const phase =
    (along - time * AMBIENT_GUST.speed) * K + Math.sin(across * 0.035 + time * 0.13) * 1.6
  const band = smooth(0.15, 0.95, Math.sin(phase) * 0.5 + 0.5)
  const patch = 0.55 + 0.45 * Math.sin(across * 0.06 - time * 0.05 + 1.3)
  return band * patch * (0.25 + 0.75 * gustSpell(time))
}

/** `ambientGust` in a shader; `wind` is the unit wind direction in world XZ. */
export function ambientGustNode(
  position: Node<'vec3'>,
  time: Node<'float'>,
  wind: Node<'vec2'>,
): Node<'float'> {
  const along = position.x.mul(wind.x).add(position.z.mul(wind.y))
  const across = position.z.mul(wind.x).sub(position.x.mul(wind.y))
  const phase = along
    .sub(time.mul(AMBIENT_GUST.speed))
    .mul(K)
    .add(sin(across.mul(0.035).add(time.mul(0.13))).mul(1.6))
  const band = smoothstep(0.15, 0.95, sin(phase).mul(0.5).add(0.5))
  const patch = sin(across.mul(0.06).sub(time.mul(0.05)).add(1.3))
    .mul(0.45)
    .add(0.55)
  const spell = smoothstep(
    -0.25,
    0.75,
    sin(time.mul(0.081).add(0.4))
      .mul(0.6)
      .add(sin(time.mul(0.029).add(2.1)).mul(0.4)),
  )
  return band.mul(patch).mul(spell.mul(0.75).add(float(0.25)))
}
