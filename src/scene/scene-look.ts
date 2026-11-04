/**
 * The scene's art direction, after Voxen's Last Signal: a muted base grade, haze that
 * separates depth planes, low mist over the water, and a golden hour that alone lifts
 * saturation, contrast and sun scattering. Values are layered as multipliers:
 * base → golden hour → weather → night, so each layer stays readable on its own.
 */
type Rgb = readonly [number, number, number]

export type SceneLook = Readonly<{
  exposure: number
  contrast: number
  saturation: number
  /** Linear white-balance gains applied before tone mapping. */
  tint: Rgb
  vignette: number
  /** Display-space film grain amplitude, strongest in midtones. */
  grain: number
  /** Multiplier on the weather's base air extinction. */
  haze: number
  /** Distance in metres before haze starts to extinguish: keeps the foreground crisp. */
  hazeStart: number
  /** Exponential thinning of haze per metre of height. */
  hazeFalloff: number
  /** Extinction of the mist layer lying on the water, in 1/m. */
  mist: number
  /** Height above the water where the mist layer ends. */
  mistTop: number
  /** Multiplier on in-scattered direct light: shafts and the sun's forward glow. */
  sunScattering: number
}>

export type LookPreset = Readonly<{
  base: SceneLook
  /** Multipliers at full golden-hour weight (tint is a target, not a multiplier). */
  goldenHour: Readonly<
    Pick<
      SceneLook,
      | 'exposure'
      | 'contrast'
      | 'saturation'
      | 'tint'
      | 'haze'
      | 'hazeStart'
      | 'mist'
      | 'sunScattering'
    >
  >
  /** Rain drains colour and thickens the air. */
  rain: Readonly<Pick<SceneLook, 'saturation' | 'haze' | 'mist'>>
  /** Night keeps a deeper vignette and a cooler, slightly denser mist (tint is a target). */
  night: Readonly<Pick<SceneLook, 'vignette' | 'tint' | 'mist'>>
  /** Morning mist on cloudy dawns, weighted by `mistFactor`. */
  dawnMist: number
}>

export const LAST_SIGNAL_LOOK: LookPreset = {
  base: {
    exposure: 1,
    contrast: 1.06,
    saturation: 0.8,
    tint: [1, 1, 1],
    vignette: 0.22,
    grain: 0.015,
    haze: 1.8,
    hazeStart: 22,
    hazeFalloff: 0.035,
    mist: 0.0035,
    mistTop: 2.6,
    sunScattering: 1,
  },
  goldenHour: {
    exposure: 1,
    contrast: 1.08,
    saturation: 1.3,
    tint: [1.05, 1, 0.92],
    haze: 0.95,
    hazeStart: 1,
    mist: 0.85,
    sunScattering: 1.1,
  },
  rain: { saturation: 0.9, haze: 1.7, mist: 1.6 },
  night: { vignette: 0.36, tint: [0.96, 1, 1.06], mist: 1.3 },
  dawnMist: 2.2,
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))
const smooth = (a: number, b: number, value: number) => {
  const t = clamp01((value - a) / (b - a))
  return t * t * (3 - 2 * t)
}
const mix = (a: number, b: number, t: number) => a + (b - a) * t
const lift = (factor: number, weight: number) => mix(1, factor, weight)

/**
 * Golden-hour weight from the sun's elevation: none at the horizon, full from 4° to 14°,
 * gone by 26°. Both ends of the day qualify: the fixed camera frames sunrise and sunset.
 */
export function goldenHourShare(sunHeight: number) {
  const degrees = (Math.asin(Math.max(-1, Math.min(1, sunHeight))) * 180) / Math.PI
  return smooth(0, 4, degrees) * (1 - smooth(14, 26, degrees))
}

export type LookInputs = Readonly<{
  sunHeight: number
  daylight: number
  rain: number
  /** Morning mist weight, see `mistFactor` in lighting. */
  mist: number
}>

export function sampleLook(inputs: LookInputs, look = LAST_SIGNAL_LOOK): SceneLook {
  const { base, goldenHour, rain, night } = look
  const golden = goldenHourShare(inputs.sunHeight)
  const wet = clamp01(inputs.rain)
  const dark = 1 - clamp01(inputs.daylight)
  const channel = (index: 0 | 1 | 2) =>
    mix(mix(base.tint[index], goldenHour.tint[index], golden), night.tint[index], dark)
  return {
    exposure: base.exposure * lift(goldenHour.exposure, golden),
    contrast: base.contrast * lift(goldenHour.contrast, golden),
    saturation: base.saturation * lift(goldenHour.saturation, golden) * lift(rain.saturation, wet),
    tint: [channel(0), channel(1), channel(2)],
    vignette: mix(base.vignette, night.vignette, dark),
    grain: base.grain,
    haze: base.haze * lift(goldenHour.haze, golden) * lift(rain.haze, wet),
    hazeStart: base.hazeStart * lift(goldenHour.hazeStart, golden),
    hazeFalloff: base.hazeFalloff,
    mist:
      base.mist *
      lift(goldenHour.mist, golden) *
      lift(rain.mist, wet) *
      lift(night.mist, dark) *
      (1 + look.dawnMist * clamp01(inputs.mist)),
    mistTop: base.mistTop,
    sunScattering: base.sunScattering * lift(goldenHour.sunScattering, golden),
  }
}
