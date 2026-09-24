import { luminance, rgb } from './atmosphere-physics'
import type { Rgb } from './atmosphere-physics'
import { SKY_TABLE } from './atmosphere-table'

/** Display scale of physical sky radiance at noon, before eye adaptation. */
export const SKY_EXPOSURE = 9
const MAX_ADAPTATION = 48

const degrees = (sunHeight: number) =>
  (Math.asin(Math.max(-1, Math.min(1, sunHeight))) * 180) / Math.PI

function tableAt(values: readonly number[], sunHeight: number): Rgb {
  const e = SKY_TABLE.elevations,
    x = Math.min(90, degrees(sunHeight))
  let i = 0
  while (i < e.length - 2 && (e[i + 1] ?? Infinity) < x) i++
  const a = e[i] ?? 0,
    b = e[i + 1] ?? 1,
    t = (x - a) / (b - a)
  // Log interpolation follows the exponential twilight decay and extrapolates below the table.
  return rgb((c) => {
    const lo = Math.log(values[i * 3 + c] ?? 1e-12),
      hi = Math.log(values[(i + 1) * 3 + c] ?? 1e-12)
    return Math.exp(lo + (hi - lo) * t)
  })
}

/** Hemispherical sky irradiance at the viewer, multiple scattering included. */
export const skyIrradiance = (sunHeight: number) => tableAt(SKY_TABLE.irradiance, sunHeight)
/** Sky radiance just above the horizon, averaged over azimuth. */
export const horizonRadiance = (sunHeight: number) => tableAt(SKY_TABLE.horizon, sunHeight)

const NOON_IRRADIANCE = luminance(skyIrradiance(0.85))
/** Partial exposure adaptation: twilight reads as dim, not black. */
export function eyeAdaptation(sunHeight: number) {
  const ratio = NOON_IRRADIANCE / Math.max(1e-12, luminance(skyIrradiance(sunHeight)))
  return Math.min(MAX_ADAPTATION, Math.max(1, Math.sqrt(ratio)))
}

function lift(h: number) {
  const elevation = Math.max(-1.8, h)
  const arcminutes = 1.02 / Math.tan(((elevation + 10.3 / (elevation + 5.11)) * Math.PI) / 180)
  return (arcminutes * Math.PI) / (180 * 60)
}
/** Sæmundsson refraction in radians for a true elevation, with the disc's vertical scale. */
export function refraction(sunHeight: number) {
  const h = degrees(sunHeight),
    derivative = ((lift(h + 0.1) - lift(h - 0.1)) * 180) / (Math.PI * 0.2)
  return { lift: lift(h), flattening: Math.min(1, Math.max(0.7, 1 + derivative)) }
}
