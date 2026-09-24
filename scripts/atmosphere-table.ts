// Bakes the CPU sky table: `node scripts/atmosphere-table.ts && pnpm fmt`.
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  EARTH,
  extinctionAt,
  raySphere,
  rgb,
  transmittance,
} from '../src/scene/atmosphere-physics.ts'
import type { Rgb } from '../src/scene/atmosphere-physics.ts'

type Vec = readonly [number, number, number]
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const { groundRadius: Rg, topRadius: Rt } = EARTH

class Table {
  readonly data: Float64Array
  readonly width: number
  readonly height: number
  constructor(width: number, height: number, fill: (x: number, y: number) => Rgb) {
    this.width = width
    this.height = height
    this.data = new Float64Array(width * height * 3)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) this.data.set(fill(x, y), (y * width + x) * 3)
  }
  sample(u: number, v: number): Rgb {
    const x = Math.min(this.width - 1, Math.max(0, u * this.width - 0.5)),
      y = Math.min(this.height - 1, Math.max(0, v * this.height - 0.5))
    const i = Math.min(this.width - 2, Math.floor(x)),
      j = Math.min(this.height - 2, Math.floor(y)),
      fx = x - i,
      fy = y - j
    const at = (a: number, b: number, c: number) => this.data[(b * this.width + a) * 3 + c] ?? 0
    return rgb(
      (c) =>
        (at(i, j, c) * (1 - fx) + at(i + 1, j, c) * fx) * (1 - fy) +
        (at(i, j + 1, c) * (1 - fx) + at(i + 1, j + 1, c) * fx) * fy,
    )
  }
}

const TRANSMITTANCE = new Table(256, 64, (x, y) =>
  transmittance(((y + 0.5) / 64) ** 2 * (Rt - Rg), ((x + 0.5) / 256) * 2 - 1),
)
const sunlight = (radius: number, mu: number): Rgb =>
  raySphere(radius, mu, Rg) > 0
    ? [0, 0, 0]
    : TRANSMITTANCE.sample((mu + 1) / 2, Math.sqrt(Math.max(0, radius - Rg) / (Rt - Rg)))

const g = EARTH.mieAnisotropy
const miePhase = (c: number) =>
  ((3 / (8 * Math.PI)) * (1 - g * g) * (1 + c * c)) / ((2 + g * g) * (1 + g * g - 2 * g * c) ** 1.5)
const rayleighPhase = (c: number) => (3 / (16 * Math.PI)) * (1 + c * c)

type March = {
  radius: number
  ray: Vec
  sun: Vec
  steps: number
  isotropic: boolean
  multiple?: Table
}
function march({ radius, ray, sun, steps, isotropic, multiple }: March) {
  const ground = raySphere(radius, ray[1], Rg),
    length = ground > 0 ? ground : raySphere(radius, ray[1], Rt),
    dt = length / steps,
    cosine = dot(ray, sun)
  const rayleigh = isotropic ? 1 / (4 * Math.PI) : rayleighPhase(cosine),
    mie = isotropic ? 1 / (4 * Math.PI) : miePhase(cosine)
  const light = [0, 0, 0],
    transfer = [0, 0, 0],
    throughput = [1, 1, 1]
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.3) * dt
    const p: Vec = [ray[0] * t, radius + ray[1] * t, ray[2] * t]
    const r = Math.hypot(...p),
      h = r - Rg,
      mu = dot(p, sun) / r
    const extinction = extinctionAt(h),
      direct = sunlight(r, mu),
      psi: Rgb = multiple
        ? multiple.sample((mu + 1) / 2, Math.min(1, Math.max(0, h / (Rt - Rg))))
        : [0, 0, 0]
    const density = Math.exp(-h / EARTH.rayleighHeight),
      aerosol = Math.exp(-h / EARTH.mieHeight)
    for (const c of [0, 1, 2] as const) {
      const sR = EARTH.rayleighScattering[c] * density,
        sM = EARTH.mieScattering * aerosol,
        e = extinction[c],
        step = Math.exp(-e * dt),
        source = direct[c] * (sR * rayleigh + sM * mie) + psi[c] * (sR + sM),
        value = throughput[c] ?? 0
      light[c] = (light[c] ?? 0) + (value * (source - source * step)) / e
      transfer[c] = (transfer[c] ?? 0) + (value * (sR + sM) * (1 - step)) / e
      throughput[c] = value * step
    }
  }
  if (ground > 0 && !multiple) {
    const p: Vec = [ray[0] * length, radius + ray[1] * length, ray[2] * length]
    const r = Math.hypot(...p),
      mu = dot(p, sun) / r,
      direct = sunlight(r, mu)
    for (const c of [0, 1, 2] as const)
      light[c] =
        (light[c] ?? 0) +
        ((throughput[c] ?? 0) * direct[c] * Math.max(0, mu) * EARTH.groundAlbedo) / Math.PI
  }
  return { light: rgb((c) => light[c] ?? 0), transfer: rgb((c) => transfer[c] ?? 0) }
}

const MULTIPLE = new Table(32, 32, (x, y) => {
  const mu = ((x + 0.5) / 32) * 2 - 1,
    radius = Rg + ((y + 0.5) / 32) * (Rt - Rg),
    sun: Vec = [Math.sqrt(1 - mu * mu), mu, 0]
  const light = [0, 0, 0],
    transfer = [0, 0, 0]
  for (let a = 0; a < 8; a++)
    for (let b = 0; b < 8; b++) {
      const theta = (2 * Math.PI * (a + 0.5)) / 8,
        phi = Math.acos(1 - (2 * (b + 0.5)) / 8)
      const ray: Vec = [
        Math.cos(theta) * Math.sin(phi),
        Math.cos(phi),
        Math.sin(theta) * Math.sin(phi),
      ]
      const result = march({ radius, ray, sun, steps: 20, isotropic: true })
      for (const c of [0, 1, 2] as const) {
        light[c] = (light[c] ?? 0) + result.light[c] / 64
        transfer[c] = (transfer[c] ?? 0) + result.transfer[c] / 64
      }
    }
  return rgb((c) => (light[c] ?? 0) / (1 - (transfer[c] ?? 0)))
})

const direction = (azimuth: number, elevation: number): Vec => [
  Math.sin(azimuth) * Math.cos(elevation),
  Math.sin(elevation),
  -Math.cos(azimuth) * Math.cos(elevation),
]
const radiance = (ray: Vec, sun: Vec) =>
  march({
    radius: Rg + EARTH.viewerHeight,
    ray,
    sun,
    steps: 40,
    isotropic: false,
    multiple: MULTIPLE,
  }).light

const elevations = [
  -14, -12, -10, -8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 6, 8, 10, 14, 20, 30, 45, 60, 90,
]
const irradiance: number[] = [],
  horizon: number[] = []
const digits = (value: number) => Number(value.toPrecision(4))
for (const degrees of elevations) {
  const sun = direction(0, (degrees * Math.PI) / 180)
  const e = [0, 0, 0],
    h = [0, 0, 0]
  const AZIMUTHS = 24,
    RINGS = 12
  for (let i = 0; i < AZIMUTHS; i++) {
    const azimuth = ((i + 0.5) / AZIMUTHS) * 2 * Math.PI
    for (let j = 0; j < RINGS; j++) {
      const elevation = ((j + 0.5) / RINGS) * (Math.PI / 2),
        weight = Math.sin(elevation) * Math.cos(elevation) * ((2 * Math.PI) / AZIMUTHS)
      const value = radiance(direction(azimuth, elevation), sun)
      for (const c of [0, 1, 2] as const)
        e[c] = (e[c] ?? 0) + value[c] * weight * (Math.PI / 2 / RINGS)
    }
    const low = radiance(direction(azimuth, (1.5 * Math.PI) / 180), sun)
    for (const c of [0, 1, 2] as const) h[c] = (h[c] ?? 0) + low[c] / AZIMUTHS
  }
  irradiance.push(...e.map((v) => digits(Math.max(v, 1e-15))))
  horizon.push(...h.map((v) => digits(Math.max(v, 1e-15))))
}

const output = `/** Generated by scripts/atmosphere-table.ts; sun elevations in degrees. */
export const SKY_TABLE = {
  elevations: ${JSON.stringify(elevations)},
  irradiance: ${JSON.stringify(irradiance)},
  horizon: ${JSON.stringify(horizon)},
} as const
`
await writeFile(resolve(import.meta.dirname, '../src/scene/atmosphere-table.ts'), output)
