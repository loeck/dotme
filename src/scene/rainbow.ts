import { acos, clamp, dot, exp, smoothstep, vec3 } from 'three/tsl'
import type { Vector3 } from 'three/webgpu'
import type { Node } from 'three/webgpu'

/**
 * Angular radii of the bows round their centre, degrees: the primary's red edge at 42.3°, the
 * secondary's at 50.4° with its colours reversed (Descartes; water's dispersion spreads each
 * band over about 1.7° and 3°).
 */
const RAINBOW = {
  primary: { red: 42.2, green: 41.4, blue: 40.6, width: 0.55 },
  secondary: { red: 50.5, green: 51.5, blue: 52.6, width: 0.85, strength: 0.38 },
  /** Azimuth of the staged centre either side of the view's axis, radians. */
  offset: 0.7,
  /**
   * Sideways sun (x of its direction) beyond which the bow stands fully to the other side. The
   * day's arc crosses the view's axis in the late afternoon, about 17° up while a bow may show:
   * the centre glides across the frame there instead of jumping between sides.
   */
  crossing: 0.3,
} as const

/**
 * Where the bow is centred. A rainbow stands round the anti-solar point, but the fixed camera
 * faces the low sun at both ends of the day (and has it behind its shoulder only near noon, when
 * the bow is below the horizon), so a true bow would always be out of frame. Like the moon, it
 * is staged: centred in front of the camera, on the side away from the sun (easing across as the
 * sun crosses the view's axis), as far below the horizon as the sun stands above it, so its height
 * and size follow the sun as a real bow's do.
 */
export function stagedRainbowCentre(sun: Readonly<Vector3>, target: Vector3) {
  const elevation = Math.asin(Math.max(-1, Math.min(1, sun.y)))
  const side = Number.isFinite(sun.x) ? Math.max(-1, Math.min(1, sun.x / RAINBOW.crossing)) : 1
  const azimuth = -side * RAINBOW.offset
  const flat = Math.cos(elevation)
  return target.set(Math.sin(azimuth) * flat, -Math.sin(elevation), -Math.cos(azimuth) * flat)
}

/**
 * The bows' radiance for a sky direction: three Gaussian bands per bow (red outside the primary,
 * inside the secondary), a faint brightening inside the primary, fading toward the horizon and
 * up into the sky where no rain falls. Multiply by the sunlight on the drops and the strength.
 */
export function rainbowSpectrum(direction: Node<'vec3'>, centre: Node<'vec3'>) {
  const theta = acos(clamp(dot(direction, centre), -1, 1)).mul(180 / Math.PI)
  const band = (degrees: number, width: number) =>
    exp(theta.sub(degrees).div(width).pow2().mul(-0.5))
  const { primary: p, secondary: s } = RAINBOW
  const first = vec3(
    band(p.red, p.width),
    band(p.green, p.width).mul(0.9),
    band(p.blue, p.width * 1.1).mul(0.85),
  )
  const second = vec3(
    band(s.red, s.width),
    band(s.green, s.width).mul(0.9),
    band(s.blue, s.width * 1.1).mul(0.85),
  ).mul(s.strength)
  // Light scattered just inside the primary: the sky under a bow is brighter than outside it.
  const inside = smoothstep(p.blue - 0.4, p.blue - 9, theta)
    .mul(smoothstep(p.blue - 22, p.blue - 9, theta))
    .mul(0.07)
  const presence = smoothstep(-0.005, 0.05, direction.y).mul(smoothstep(0.62, 0.22, direction.y))
  return first.add(second).add(vec3(inside)).mul(presence)
}
