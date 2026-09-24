export type Rgb = readonly [number, number, number]
export type Channel = 0 | 1 | 2
export const rgb = (f: (c: Channel) => number): Rgb => [f(0), f(1), f(2)]

/**
 * Earth atmosphere of Hillaire, "A Scalable and Production Ready Sky and Atmosphere
 * Rendering Technique" (EGSR 2020). Distances in kilometres, coefficients per kilometre.
 */
export const EARTH = {
  groundRadius: 6360,
  topRadius: 6460,
  viewerHeight: 0.25,
  rayleighScattering: [5.802e-3, 13.558e-3, 33.1e-3],
  rayleighHeight: 8,
  mieScattering: 3.996e-3,
  mieExtinction: 4.44e-3,
  mieHeight: 1.2,
  mieAnisotropy: 0.8,
  ozoneAbsorption: [0.65e-3, 1.881e-3, 0.085e-3],
  ozoneCenter: 25,
  ozoneHalfWidth: 15,
  groundAlbedo: 0.3,
} as const

export const luminance = (c: Rgb) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722

export function extinctionAt(height: number): Rgb {
  const rayleigh = Math.exp(-height / EARTH.rayleighHeight),
    mie = Math.exp(-height / EARTH.mieHeight),
    ozone = Math.max(0, 1 - Math.abs(height - EARTH.ozoneCenter) / EARTH.ozoneHalfWidth)
  return rgb(
    (c) =>
      EARTH.rayleighScattering[c] * rayleigh +
      EARTH.mieExtinction * mie +
      EARTH.ozoneAbsorption[c] * ozone,
  )
}

/** Distance to the first positive intersection with a centred sphere, or -1. */
export function raySphere(radius: number, mu: number, sphere: number) {
  const discriminant = radius * radius * (mu * mu - 1) + sphere * sphere
  if (discriminant < 0) return -1
  const root = Math.sqrt(discriminant),
    near = -radius * mu - root,
    far = -radius * mu + root
  return near > 0 ? near : far > 0 ? far : -1
}

/** Direct sunlight reaching `height` from a sun at `mu` (cosine of the zenith angle). */
export function transmittance(height: number, mu: number, steps = 40): Rgb {
  const radius = EARTH.groundRadius + Math.max(0, height)
  if (raySphere(radius, mu, EARTH.groundRadius) > 0) return [0, 0, 0]
  const length = raySphere(radius, mu, EARTH.topRadius),
    dt = length / steps
  let r = 0,
    g = 0,
    b = 0
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt
    const h = Math.sqrt(radius * radius + t * t + 2 * radius * mu * t) - EARTH.groundRadius
    const [er, eg, eb] = extinctionAt(h)
    r += er * dt
    g += eg * dt
    b += eb * dt
  }
  return [Math.exp(-r), Math.exp(-g), Math.exp(-b)]
}
